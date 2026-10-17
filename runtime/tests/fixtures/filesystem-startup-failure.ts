import { installFilesystemWorker } from "../../fs/service";

installFilesystemWorker(self, async () => {
  throw new Error("Filesystem fixture cannot open storage");
});
