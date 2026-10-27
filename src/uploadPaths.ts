export type UploadPage = { uid: string; title: string };

const truncateUtf8 = (value: string, limit: number): string => {
  let result = "";
  for (const character of value) {
    if (new TextEncoder().encode(result + character).length > limit) break;
    result += character;
  }
  return result;
};

const safeComponent = (value: string): string => {
  const safe = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/[ .]+$/g, "");
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safe)
    ? `_${safe}`
    : safe;
};

export const getPageFolder = ({ uid, title }: UploadPage): string => {
  if (!uid || !title) {
    throw new Error(
      "Could not identify the upload's Roam page. Please try again."
    );
  }
  // Hex preserves case-sensitive Roam identities on Dropbox's case-insensitive paths.
  const identity = Array.from(new TextEncoder().encode(uid), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const name = safeComponent(truncateUtf8(safeComponent(title), 80)) || "Page";
  return `/${name}--${identity}`;
};

export const getDropboxUploadPath = ({
  fileName,
  folder = "",
}: {
  fileName: string;
  folder?: string;
}): string => {
  const safeName = folder
    ? safeComponent(fileName) || "upload"
    : fileName.replace(/[\\/]/g, "-") || "upload";
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const extensionIndex = safeName.lastIndexOf(".");
  const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : "";
  const stem =
    extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
  // Keep the page path comfortably below Dropbox's cross-platform path limit.
  return folder
    ? `${folder}/${truncateUtf8(stem, 60)}-${id}${truncateUtf8(extension, 20)}`
    : `/${stem}-${id}${extension}`;
};

export const ensureDropboxFolder = async ({
  path,
  createFolder,
  getMetadata,
}: {
  path: string;
  createFolder: (path: string) => Promise<unknown>;
  getMetadata: (path: string) => Promise<{ ".tag"?: string }>;
}): Promise<void> => {
  try {
    await createFolder(path);
  } catch (error) {
    // Reuse only a confirmed folder, including a concurrent upload's creation.
    // Permission/network errors and same-named files must still fail the upload.
    const metadata = await getMetadata(path).catch(() => {
      throw error;
    });
    if (metadata[".tag"] !== "folder") throw error;
  }
};
