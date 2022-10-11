import runExtension from "roamjs-components/util/runExtension";

export default runExtension({
  run: (args) => {
    args.extensionAPI.settings.panel.create({
      tabTitle: "dropbox",
      settings: [],
    });
  },
});
