import { installFilesystemWorker } from "../../fs/service";

installFilesystemWorker(self, async options => {
  if (options.reason === "hostile") throw { toString() { throw new Error("conversion failed"); }, get stack() { throw new Error("stack failed"); } };
  if (options.reason === "null-prototype") throw Object.create(null);
  throw new Error("Filesystem fixture cannot open storage");
});
