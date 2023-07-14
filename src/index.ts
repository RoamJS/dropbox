import runExtension from "roamjs-components/util/runExtension";
import getOauth from "roamjs-components/util/getOauth";
import getDropUidOffset from "roamjs-components/dom/getDropUidOffset";
import DropboxLogo from "./components/DropboxLogo";
import differenceInSeconds from "date-fns/differenceInSeconds";
import createBlock from "roamjs-components/writes/createBlock";
import updateBlock from "roamjs-components/writes/updateBlock";
import getUids from "roamjs-components/dom/getUids";
import createHTMLObserver from "roamjs-components/dom/createHTMLObserver";
import localStorageGet from "roamjs-components/util/localStorageGet";
import localStorageSet from "roamjs-components/util/localStorageSet";
import OauthPanel from "roamjs-components/components/OauthPanel";
import React from "react";
import apiPost from "roamjs-components/util/apiPost";
import mimeTypes from "./mimeTypes";

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
          component: () =>
            React.createElement(OauthPanel, {
              service: "dropbox",
              ServiceIcon: DropboxLogo,
              getPopoutUrl: () =>
                Promise.resolve(
                  `https://www.dropbox.com/oauth2/authorize?client_id=ghagecp4sgm6v99&redirect_uri=${encodeURIComponent(
                    "https://roamjs.com/oauth?auth=true"
                  )}&response_type=code&token_access_type=offline`
                ),
              getAuthData: (data) =>
                apiPost({
                  domain: `https://lambda.roamjs.com`,
                  path: `dropbox-auth`,
                  anonymous: true,
                  data: {
                    ...JSON.parse(data),
                    grant_type: "authorization_code",
                    redirect_uri: "https://roamjs.com/oauth?auth=true",
                    dev: undefined,
                  },
                }),
            }),
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
        time ? new Date(time) : new Date(0)
      );
      return tokenAge > expires_in
        ? apiPost<{ access_token: string }>({
            domain: `https://lambda.roamjs.com`,
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
                  `Did not find an access token. Found: ${JSON.stringify(r)}`
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
                        : at
                  )
                )
              );
              return r.access_token;
            })
            .catch((e) =>
              Promise.reject(
                `Failed to refresh your access token: ${
                  e.response.data || e.message
                }`
              )
            )
        : Promise.resolve(access_token);
    } else {
      return Promise.reject(
        "Could not find your login info. Try first logging in through the [[roam/js/dropbox]] page"
      );
    }
  };

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
      getLoadingUid().then((uid) => {
        const catchError = (e: unknown) => {
          updateBlock({
            uid,
            text: "Failed to upload file to dropbox. Email support@roamjs.com with the error below:",
          });
          createBlock({
            parentUid: uid,
            node: { text: JSON.stringify(e) },
          });
        };
        return getAccessToken()
          .then(async (access_token) => {
            const reader = new FileReader();

            reader.readAsBinaryString(fileToUpload);
            reader.onloadend = async () =>
              apiPost<{ name: string; path_display: string }>({
                path: "files/alpha/upload",
                data: new Uint8Array(await fileToUpload.arrayBuffer()),
                domain: "https://content.dropboxapi.com/2",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Dropbox-API-Arg": httpHeaderSafeJson({
                    path: `/${fileToUpload.name}`,
                    autorename: true,
                  }),
                },
                authorization: `Bearer ${access_token}`,
              })
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
                        }).then((c) => ({ url: c.url, contentType }))
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
                            "dl.dropboxusercontent.com"
                          )})`
                        : `[${fileToUpload.name}](${dbxUrl})`
                      : `Unknown Content type for file ${fileToUpload.name}`,
                  });
                })
                .catch(catchError)
                .finally(() => {
                  Array.from(document.getElementsByClassName("dnd-drop-bar"))
                    .map((c) => c as HTMLDivElement)
                    .forEach((c) => (c.style.display = "none"));
                });
          })
          .catch(catchError);
      });
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  createHTMLObserver({
    tag: "DIV",
    className: "dnd-drop-area",
    callback: (d) => {
      d.addEventListener("drop", (e) => {
        uploadToDropbox({
          files: e.dataTransfer?.files || null,
          getLoadingUid: () => {
            const { parentUid, offset } = getDropUidOffset(d as HTMLDivElement);
            return createBlock({
              parentUid,
              order: offset,
              node: { text: "Loading..." },
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
      textareaRef.current = t as HTMLTextAreaElement;
      t.addEventListener("paste", (e) => {
        uploadToDropbox({
          files: e.clipboardData?.files || null,
          getLoadingUid: () => {
            const { blockUid } = getUids(t as HTMLTextAreaElement);
            return updateBlock({
              text: "Loading...",
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
      target.addEventListener(
        "change",
        (e) => {
          uploadToDropbox({
            files: (e.target as HTMLInputElement).files,
            getLoadingUid: () => {
              const { blockUid } = getUids(textareaRef.current);
              return updateBlock({
                text: "Loading...",
                uid: blockUid,
              });
            },
            e,
          });
        },
        true
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
