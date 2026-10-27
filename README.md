<a href="https://roamjs.com/">
    <img src="https://avatars.githubusercontent.com/u/138642184" alt="RoamJS Logo" title="RoamJS" align="right" height="60" />
</a>

# Dropbox

**Automatically send Roam file uploads to Dropbox. Intercepts attachments, uploads them to your Dropbox, and replaces the upload with a shareable link (audio/pdf/video supported). Keep your graph light while storing files in the cloud.**

[![RoamJS](https://roamjs.com/badges/website.svg)](https://roamjs.com/) [![DeepWiki](https://roamjs.com/badges/deepwiki.svg)](https://deepwiki.com/RoamJS/dropbox) [![Slack](https://roamjs.com/badges/slack.svg)](https://roamresearch.slack.com/archives/C016N2B66JU)

## Usage

First, navigate to the Roam Depot Settings to log into Roam with your Dropbox account. Once you grant RoamJS access to upload files for you, your credentials will be stored in your browser.

Anytime you upload a file to Roam, the dropbox extension will intercept the upload and send it to your dropbox account instead!

## Demo

<video src="https://roamjs.com/loom/d13ece9f31474b1ab02d0109b3101fe0.mp4" controls="controls"></video>

[View on Loom](https://www.loom.com/share/d13ece9f31474b1ab02d0109b3101fe0)

## Organize uploads by page

Enable **Organize uploads by page** in the Dropbox extension settings to put new uploads in a folder under `Dropbox/Apps/RoamJS`. The default remains uploading directly into that directory.

Folders use the destination block's page, including blocks in the sidebar and linked references. Each folder is named `Page title--page-id`, where the encoded page ID keeps distinct pages separate even when their titles differ only in case or become identical after replacing unsupported characters. Unsupported characters are replaced with `-`, long titles are shortened, and Unicode titles are supported. Uploaded files retain a unique suffix so repeated filenames do not overwrite earlier files.

Renaming a page creates a folder with the new title on its next upload. Existing folders, files, and embeds are left untouched. Disabling the setting returns future uploads to the root folder. If the page cannot be resolved or its folder cannot be created or reused, the upload reports an error instead of silently saving elsewhere.
