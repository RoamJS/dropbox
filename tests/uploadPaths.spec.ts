import { test, expect } from "@playwright/test";
import {
  ensureDropboxFolder,
  getDropboxUploadPath,
  getPageFolder,
} from "../src/uploadPaths";
import { webcrypto } from "crypto";

// The legacy test runner can run on Node versions without global Web Crypto.
Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const page = { uid: "Abc123_-Z", title: "My page" };

test("page folders are stable and distinguish sanitized, case and Unicode collisions", () => {
  expect(getPageFolder(page)).toBe(getPageFolder(page));
  expect(getPageFolder(page)).toMatch(/^\/My page--[0-9a-f]+$/);
  for (const [first, second] of [
    ["a/b", "a\\b"],
    ["Notes", "notes"],
    ["e\u0301", "é"],
  ]) {
    expect(
      getPageFolder({ uid: "pageabcde", title: first }).toLowerCase()
    ).not.toBe(
      getPageFolder({ uid: "pageABCDE", title: second }).toLowerCase()
    );
  }
});

test("page folder names safely handle reserved characters, names, empty stems and long Unicode", () => {
  for (const title of [
    '<>:"/\\|?*\0\x1f\x7f',
    "...",
    "CON",
    "aux.txt",
    "hello. ",
    "🦊é".repeat(200),
  ]) {
    const folder = getPageFolder({ ...page, title });
    expect(folder.slice(1)).not.toMatch(/[<>:"/\\|?*\x00-\x1f\x7f]/);
    expect(Buffer.byteLength(folder)).toBeLessThan(110);
    expect(folder).not.toContain("�");
  }
  expect(getPageFolder({ ...page, title: "CON" })).toContain("/_CON--");
  expect(getPageFolder({ ...page, title: "..." })).toContain("/Page--");
  expect(() => getPageFolder({ uid: "", title: "x" })).toThrow(/identify/);
});

test("renames affect future paths without changing the page identity", () => {
  const oldPath = getPageFolder(page);
  const renamedPath = getPageFolder({ ...page, title: "New title" });
  expect(oldPath).not.toBe(renamedPath);
  expect(oldPath.split("--")[1]).toBe(renamedPath.split("--")[1]);
});

test("default uploads stay at root and repeated filenames are unique", () => {
  const first = getDropboxUploadPath({ fileName: "file.pdf" });
  const second = getDropboxUploadPath({ fileName: "file.pdf" });
  expect(first).toMatch(/^\/file-[^/]+\.pdf$/);
  expect(first).not.toBe(second);
});

test("page upload filenames are safe, bounded and preserve the extension", () => {
  const path = getDropboxUploadPath({
    fileName: `${"🦊".repeat(200)}<>:\"/\\|?*.pdf`,
    folder: getPageFolder(page),
  });
  expect(path.split("/")).toHaveLength(3);
  expect(path).toMatch(/\.pdf$/);
  expect(Buffer.byteLength(path)).toBeLessThan(260);
  expect(path.split("/")[2]).not.toMatch(/[<>:"\\|?*]/);
});

test("create a folder or reuse only a verified existing folder", async () => {
  const calls: string[] = [];
  const createFolder = async (path: string) => {
    calls.push(path);
  };
  await ensureDropboxFolder({
    path: "/page",
    createFolder,
    getMetadata: async () => {
      throw new Error("unnecessary metadata lookup");
    },
  });
  expect(calls).toEqual(["/page"]);
  await ensureDropboxFolder({
    path: "/page",
    createFolder: async () => {
      throw new Error("folder conflict");
    },
    getMetadata: async () => ({ ".tag": "folder" }),
  });
});

test("folder creation fails on a file conflict, permission error or failed metadata lookup", async () => {
  for (const tag of ["file", "deleted", undefined]) {
    await expect(
      ensureDropboxFolder({
        path: "/page",
        createFolder: async () => {
          throw new Error("cannot create");
        },
        getMetadata: async () => ({ ".tag": tag }),
      })
    ).rejects.toThrow("cannot create");
  }
  await expect(
    ensureDropboxFolder({
      path: "/page",
      createFolder: async () => {
        throw new Error("permission denied");
      },
      getMetadata: async () => {
        throw new Error("lookup failed");
      },
    })
  ).rejects.toThrow("permission denied");
});
