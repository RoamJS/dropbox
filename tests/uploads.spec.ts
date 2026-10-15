import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import vm from "vm";
import { JSDOM } from "jsdom";
import { webcrypto } from "crypto";

let source: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    plugins: [
      {
        name: "host-fixture",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(roamjs-components\/|react$|@blueprintjs\/core$)|DropboxOauthPanel$/,
            },
            ({ path }) => ({ path, namespace: "fixture" })
          );
          builder.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path }) => ({
              contents: `module.exports = mocks[${JSON.stringify(
                path
              )}] || {};`,
            })
          );
        },
      },
    ],
  });
  source = bundle.outputFiles[0].text;
});

const setup = async ({
  enabled = true,
  missingPage = false,
  folderError = false,
} = {}) => {
  const { window } = new JSDOM("<body></body>");
  const calls: { path: string; data?: any; headers?: any }[] = [];
  const updated: { uid: string; text: string }[] = [];
  const observers: Record<string, (element: HTMLElement) => void> = {};
  const pages = {
    source001: { ":block/uid": "page00001", ":node/title": "Source / page" },
    sidebar01: { ":block/uid": "page00002", ":node/title": "Sidebar" },
  };
  const settings = { get: () => enabled, panel: { create: () => undefined } };
  const mocks = {
    "roamjs-components/util/runExtension": (run) =>
      run({ extensionAPI: { settings } }),
    "roamjs-components/util/getOauth": () =>
      JSON.stringify({
        access_token: "fixture",
        expires_in: 3600,
        node: { time: Date.now() },
      }),
    "roamjs-components/dom/getUids": (element) => ({ blockUid: element?.id }),
    "roamjs-components/dom/getDropUidOffset": () => ({
      parentUid: "source001",
      offset: 0,
    }),
    "roamjs-components/dom/createHTMLObserver": ({ tag, callback }) => {
      observers[tag] = callback;
    },
    "roamjs-components/writes/createBlock": async () => "source001",
    "roamjs-components/writes/updateBlock": async (block) => {
      updated.push(block);
      return block.uid;
    },
    "roamjs-components/components/Loading": {
      renderLoading: () => () => undefined,
    },
    "roamjs-components/components/Toast": () => undefined,
    "@blueprintjs/core": { Intent: { DANGER: "danger" } },
    "roamjs-components/util/apiPost": async (args) => {
      const path = args.path || "upload";
      calls.push({ ...args, path });
      if (path === "files/create_folder_v2") {
        if (folderError) throw new Error("Permission denied");
        return {};
      }
      if (path === "files/get_metadata") throw new Error("Not found");
      if (path === "upload") {
        const path = JSON.parse(args.headers["Dropbox-API-Arg"]).path;
        return { name: path.split("/").pop(), path_display: path };
      }
      if (path === "sharing/list_shared_links") return { links: [] };
      if (path === "sharing/create_shared_link_with_settings")
        return { url: "https://www.dropbox.com/fixture?dl=0" };
      throw new Error(`Unexpected route ${path}`);
    },
  };
  window.roamAlphaAPI = {
    pull: (_, [, uid]) => (missingPage ? null : { ":block/page": pages[uid] }),
  };
  const context = vm.createContext({
    window,
    document: window.document,
    mocks,
    module: { exports: {} },
    crypto: webcrypto,
    TextEncoder,
    setTimeout,
  });
  vm.runInContext(source, context);
  await context.module.exports.default;
  const textarea = (uid: string) => {
    const element = window.document.createElement("textarea");
    element.id = uid;
    window.document.body.append(element);
    observers.TEXTAREA(element);
    element.focus();
    return element;
  };
  const file = (name: string) => ({
    name,
    size: 1,
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  const paste = (element, name = "same.pdf") => {
    const event = new window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [file(name)] },
    });
    element.dispatchEvent(event);
  };
  return { window, calls, updated, observers, textarea, paste, file };
};

for (const entry of ["paste", "drop", "picker"]) {
  test(`${entry} uploads to the destination page and shares Dropbox's returned path`, async () => {
    const fixture = await setup();
    const { window, calls, updated, textarea, observers, paste, file } =
      fixture;
    const target = textarea("source001");
    if (entry === "paste") paste(target);
    if (entry === "drop") {
      const element = window.document.createElement("div");
      observers.DIV(element);
      const event = new window.Event("drop", { cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file("same.pdf")] },
      });
      element.dispatchEvent(event);
    }
    if (entry === "picker") {
      const input = window.document.createElement("input");
      input.type = "file";
      window.document.body.append(input);
      input.dispatchEvent(new window.Event("click", { bubbles: true }));
      // Changing focus while the dialog is open must not change its destination.
      textarea("sidebar01");
      Object.defineProperty(input, "files", { value: [file("same.pdf")] });
      input.dispatchEvent(
        new window.Event("change", { bubbles: true, cancelable: true })
      );
    }
    await expect
      .poll(() => updated.at(-1)?.text)
      .toBe("{{pdf: https://www.dropbox.com/fixture?raw=1}}");
    const uploadedPath = JSON.parse(
      calls.find((c) => c.path === "upload")!.headers["Dropbox-API-Arg"]
    ).path;
    expect(uploadedPath).toMatch(/^\/Source - page--[^/]+\/same-/);
    expect(updated.at(-1)?.uid).toBe("source001");
    for (const path of [
      "sharing/list_shared_links",
      "sharing/create_shared_link_with_settings",
    ]) {
      expect(calls.find((c) => c.path === path)!.data.path).toBe(uploadedPath);
    }
    window.close();
  });
}

test("refocusing an existing sidebar textarea and reusing an input updates the destination", async () => {
  const { window, textarea, file, updated, calls } = await setup();
  const side = textarea("sidebar01");
  textarea("source001");
  const input = window.document.createElement("input");
  input.type = "file";
  window.document.body.append(input);
  Object.defineProperty(input, "files", { value: [file("photo.png")] });
  input.dispatchEvent(new window.Event("click", { bubbles: true }));
  side.focus();
  input.dispatchEvent(new window.Event("click", { bubbles: true }));
  input.dispatchEvent(
    new window.Event("change", { bubbles: true, cancelable: true })
  );
  await expect.poll(() => updated.at(-1)?.text.startsWith("![](")).toBe(true);
  expect(updated.at(-1)?.uid).toBe("sidebar01");
  expect(
    JSON.parse(
      calls.find((c) => c.path === "upload")!.headers["Dropbox-API-Arg"]
    ).path
  ).toMatch(/^\/Sidebar--/);
  window.close();
});

test("disabled setting keeps root uploads and does not require page metadata", async () => {
  const { window, textarea, paste, calls, updated } = await setup({
    enabled: false,
    missingPage: true,
  });
  paste(textarea("source001"), "song.mp3");
  await expect
    .poll(() => updated.at(-1)?.text.startsWith("{{audio:"))
    .toBe(true);
  expect(calls.some((c) => c.path === "files/create_folder_v2")).toBe(false);
  expect(
    JSON.parse(
      calls.find((c) => c.path === "upload")!.headers["Dropbox-API-Arg"]
    ).path.split("/")
  ).toHaveLength(2);
  window.close();
});

for (const scenario of ["missingPage", "folderError"]) {
  test(`${scenario} reports an error without a root fallback or file upload`, async () => {
    const { window, textarea, paste, calls, updated } = await setup({
      [scenario]: true,
    });
    paste(textarea("source001"));
    await expect
      .poll(() => updated.at(-1)?.text)
      .toBe("Dropbox upload failed. Please try again.");
    expect(calls.some((c) => c.path === "upload")).toBe(false);
    window.close();
  });
}
