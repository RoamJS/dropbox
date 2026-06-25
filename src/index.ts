import runExtension from "roamjs-components/util/runExtension";
import getOauth from "roamjs-components/util/getOauth";
import getDropUidOffset from "roamjs-components/dom/getDropUidOffset";
import differenceInSeconds from "date-fns/differenceInSeconds";
import createBlock from "roamjs-components/writes/createBlock";
import updateBlock from "roamjs-components/writes/updateBlock";
import getUids from "roamjs-components/dom/getUids";
import createHTMLObserver from "roamjs-components/dom/createHTMLObserver";
import localStorageGet from "roamjs-components/util/localStorageGet";
import localStorageSet from "roamjs-components/util/localStorageSet";
import React from "react";
import apiPost from "roamjs-components/util/apiPost";
import renderToast from "roamjs-components/components/Toast";
import { renderLoading } from "roamjs-components/components/Loading";
import { Intent } from "@blueprintjs/core";
import mimeTypes from "./mimeTypes";
import DropboxOauthPanel from "./components/DropboxOauthPanel";

const DROPBOX_AUTH_DOMAIN = "https://roamjs.com";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const DROPBOX_LOADING_TEXT = "";

const mimeLookup = (path: string) => {
  if (!path || typeof path !== "string") {
    return false;
  }

  const extension = path.split(".").slice(-1)[0];

  if (!extension) {
    return false;
  }

  return mimeTypes[extension] || false;
};

// https://github.com/dropbox/dropbox-sdk-js/blob/main/src/utils.js
function getSafeUnicode(c: string) {
  const unicode = `000${c.charCodeAt(0).toString(16)}`.slice(-4);
  return `\\u${unicode}`;
}
function httpHeaderSafeJson(args: Record<string, unknown>) {
  return JSON.stringify(args).replace(/[\u007f-\uffff]/g, getSafeUnicode);
}

type DropboxFileMetadata = {
  name: string;
  path_display: string;
};

type DropboxUploadEvent = Event & {
  roamjsDropboxUploadHandled?: boolean;
};

const getProxiedUrl = (url: string) => {
  const proxyUrl = window.roamAlphaAPI?.constants?.corsAnywhereProxyUrl;
  return proxyUrl ? `${proxyUrl.replace(/\/$/, "")}/${url}` : url;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return /failed to fetch|networkerror|load failed/i.test(error.message)
      ? "The browser could not complete the Dropbox request. Please try again."
      : error.message || "The browser blocked the Dropbox request.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const e = error as {
      error_summary?: string;
      message?: string;
      error?: string;
      status?: number;
      data?: unknown;
      response?: { data?: unknown };
    };
    const nestedData = e.data || e.response?.data;
    return (
      e.error_summary ||
      e.message ||
      e.error ||
      (nestedData ? getErrorMessage(nestedData) : "") ||
      (e.status ? `Dropbox returned status ${e.status}.` : "")
    );
  }
  return "";
};

const hideDropBars = () => {
  Array.from(document.getElementsByClassName("dnd-drop-bar"))
    .map((c) => c as HTMLDivElement)
    .forEach((c) => (c.style.display = "none"));
};

const renderUploadLoading = (uid: string) => {
  let active = true;
  let attempts = 0;
  let removeLoading = () => {
    // no spinner rendered yet
  };
  const render = () => {
    if (!active) return;
    if (
      !document.querySelector(`.rm-block__input[id$="${uid}"]`) &&
      attempts < 10
    ) {
      attempts += 1;
      window.setTimeout(render, 50);
      return;
    }
    removeLoading = renderLoading(uid);
  };
  window.setTimeout(render, 1);
  return () => {
    active = false;
    removeLoading();
  };
};

export default runExtension(async (args) => {
  args.extensionAPI.settings.panel.create({
    tabTitle: "Dropbox",
    settings: [
      {
        id: "oauth",
        name: "Log In",
        description: "Log into Dropbox to connect your account to Roam!",
        action: {
          type: "reactComponent",
          component: () => React.createElement(DropboxOauthPanel),
        },
      },
    ],
  });

  const getAccessToken = () => {
    const oauth = getOauth("dropbox");
    if (oauth !== "{}") {
      const { access_token, expires_in, refresh_token, node, ...rest } =
        JSON.parse(oauth);
      const { time, uid: oauthUid } = node || {};
      const tokenAge = differenceInSeconds(
        new Date(),
        time ? new Date(time) : new Date(0),
      );
      return tokenAge > expires_in
        ? apiPost<{ access_token: string }>({
            domain: DROPBOX_AUTH_DOMAIN,
            path: `dropbox-auth`,
            data: {
              refresh_token,
              grant_type: "refresh_token",
              dev: undefined,
            },
            anonymous: true,
          })
            .then((r) => {
              if (!r.access_token) {
                return Promise.reject(
                  `Did not find an access token. Found: ${JSON.stringify(r)}`,
                );
              }
              const storageData = localStorageGet("oauth-dropbox");
              const data = JSON.stringify({
                refresh_token,
                ...rest,
                ...r,
              });
              localStorageSet(
                "oauth-dropbox",
                JSON.stringify(
                  JSON.parse(storageData).map(
                    (at: { uid: string; text: string }) =>
                      at.uid === oauthUid
                        ? {
                            uid: at.uid,
                            data,
                            time: new Date().valueOf(),
                            text: at.text,
                          }
                        : at,
                  ),
                ),
              );
              return r.access_token;
            })
            .catch((e) =>
              Promise.reject(
                `Failed to refresh your access token: ${
                  e.response.data || e.message
                }`,
              ),
            )
        : Promise.resolve(access_token);
    } else {
      return Promise.reject(
        "Could not find your login info. Try first logging in through the [[roam/js/dropbox]] page",
      );
    }
  };

  const getDropboxUploadPath = (fileName: string) => {
    const safeName = fileName.replace(/[\\/]/g, "-") || "upload";
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const extensionIndex = safeName.lastIndexOf(".");
    return extensionIndex > 0
      ? `/${safeName.slice(0, extensionIndex)}-${id}${safeName.slice(
          extensionIndex,
        )}`
      : `/${safeName}-${id}`;
  };

  const getDropboxMetadata = ({
    access_token,
    path,
  }: {
    access_token: string;
    path: string;
  }) =>
    apiPost<DropboxFileMetadata>({
      path: "files/get_metadata",
      domain: "https://api.dropboxapi.com/2",
      data: { path, dev: undefined },
      authorization: `Bearer ${access_token}`,
    });

  const recoverDropboxMetadata = ({
    access_token,
    path,
    uploadError,
    retries = 2,
  }: {
    access_token: string;
    path: string;
    uploadError: unknown;
    retries?: number;
  }): Promise<DropboxFileMetadata> =>
    getDropboxMetadata({ access_token, path }).catch((metadataError) =>
      retries
        ? new Promise<void>((resolve) => setTimeout(resolve, 250)).then(() =>
            recoverDropboxMetadata({
              access_token,
              path,
              uploadError,
              retries: retries - 1,
            }),
          )
        : Promise.reject(uploadError || metadataError),
    );

  const uploadToDropbox = ({
    files,
    getLoadingUid,
    e,
  }: {
    files: FileList | null;
    getLoadingUid: () => Promise<string>;
    e: Event;
  }) => {
    if (!files) return;
    const fileToUpload = files[0];
    if (fileToUpload) {
      const uploadEvent = e as DropboxUploadEvent;
      if (uploadEvent.roamjsDropboxUploadHandled) return;
      uploadEvent.roamjsDropboxUploadHandled = true;
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();

      getLoadingUid().then((uid) => {
        const removeLoading = renderUploadLoading(uid);
        const catchError = (e: unknown) => {
          const detail = getErrorMessage(e);
          renderToast({
            id: "dropbox-upload-error",
            intent: Intent.DANGER,
            timeout: 8000,
            content: `Dropbox upload failed. Please try again.${
              detail ? `\n\n${detail}` : ""
            }`,
          });
          updateBlock({
            uid,
            text: "Dropbox upload failed. Please try again.",
          });
        };
        return getAccessToken()
          .then(async (access_token) => {
            const uploadPath = getDropboxUploadPath(fileToUpload.name);

            return apiPost<DropboxFileMetadata>({
              href: getProxiedUrl(DROPBOX_UPLOAD_URL),
              data: new Uint8Array(await fileToUpload.arrayBuffer()),
              headers: {
                "Content-Type": "application/octet-stream",
                "Dropbox-API-Arg": httpHeaderSafeJson({
                  path: uploadPath,
                  autorename: false,
                }),
              },
              authorization: `Bearer ${access_token}`,
            })
              .catch((uploadError) =>
                recoverDropboxMetadata({
                  access_token,
                  path: uploadPath,
                  uploadError,
                }),
              )
              .then((r) => {
                const contentType = mimeLookup(r.name) || "text/plain";
                return apiPost<{ links: { url: string }[] }>({
                  path: "sharing/list_shared_links",
                  domain: "https://api.dropboxapi.com/2",
                  data: { path: r.path_display, dev: undefined },
                  authorization: `Bearer ${access_token}`,
                }).then((l) =>
                  l.links.length
                    ? { contentType, url: l.links[0].url }
                    : apiPost<{ url: string }>({
                        path: "sharing/create_shared_link_with_settings",
                        domain: "https://api.dropboxapi.com/2",
                        data: {
                          path: r.path_display,
                          settings: {
                            requested_visibility: { ".tag": "public" },
                          },
                          dev: undefined,
                        },
                        authorization: `Bearer ${access_token}`,
                      }).then((c) => ({ url: c.url, contentType })),
                );
              })
              .then(({ url, contentType }) => {
                const dbxUrl = url.replace(/dl=0$/, "raw=1");
                updateBlock({
                  uid,
                  text: contentType
                    ? contentType.includes("audio/")
                      ? `{{audio: ${dbxUrl}}}`
                      : contentType.includes("pdf")
                        ? `{{pdf: ${dbxUrl}}}`
                        : contentType.includes("video/")
                          ? `{{video: ${dbxUrl}}}`
                          : contentType.includes("image/")
                            ? `![](${dbxUrl.replace(
                                "www.dropbox.com",
                                "dl.dropboxusercontent.com",
                              )})`
                            : `[${fileToUpload.name}](${dbxUrl})`
                    : `Unknown Content type for file ${fileToUpload.name}`,
                });
              })
              .catch(catchError);
          })
          .catch(catchError)
          .finally(() => {
            removeLoading();
            hideDropBars();
          });
      });
    }
  };

  const dropAreas = new WeakSet<HTMLDivElement>();
  const textareas = new WeakSet<HTMLTextAreaElement>();
  const fileInputs = new WeakSet<HTMLInputElement>();

  createHTMLObserver({
    tag: "DIV",
    className: "dnd-drop-area",
    callback: (d) => {
      const dropArea = d as HTMLDivElement;
      if (dropAreas.has(dropArea)) return;
      dropAreas.add(dropArea);
      dropArea.addEventListener("drop", (e) => {
        uploadToDropbox({
          files: e.dataTransfer?.files || null,
          getLoadingUid: () => {
            const { parentUid, offset } = getDropUidOffset(dropArea);
            return createBlock({
              parentUid,
              order: offset,
              node: { text: DROPBOX_LOADING_TEXT },
            });
          },
          e,
        });
      });
    },
  });

  const textareaRef: { current: HTMLTextAreaElement | null } = {
    current: null,
  };

  createHTMLObserver({
    tag: "TEXTAREA",
    className: "rm-block-input",
    callback: (t) => {
      const textarea = t as HTMLTextAreaElement;
      textareaRef.current = textarea;
      if (textareas.has(textarea)) return;
      textareas.add(textarea);
      textarea.addEventListener("paste", (e) => {
        uploadToDropbox({
          files: e.clipboardData?.files || null,
          getLoadingUid: () => {
            const { blockUid } = getUids(textarea);
            return updateBlock({
              text: DROPBOX_LOADING_TEXT,
              uid: blockUid,
            });
          },
          e,
        });
      });
    },
  });

  const clickListener = (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (
      target.tagName === "INPUT" &&
      target.parentElement === document.body &&
      target.type === "file"
    ) {
      if (fileInputs.has(target)) return;
      fileInputs.add(target);
      target.addEventListener(
        "change",
        (e) => {
          uploadToDropbox({
            files: (e.target as HTMLInputElement).files,
            getLoadingUid: () => {
              const { blockUid } = getUids(textareaRef.current);
              return updateBlock({
                text: DROPBOX_LOADING_TEXT,
                uid: blockUid,
              });
            },
            e,
          });
        },
        true,
      );
    }
  };
  document.body.addEventListener("click", clickListener);

  return {
    domListeners: [
      { listener: clickListener, el: document.body, type: "click" },
    ],
  };
});
