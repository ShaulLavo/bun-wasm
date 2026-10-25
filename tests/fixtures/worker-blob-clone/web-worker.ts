import { checkPayload } from "./payload.ts";

onmessage = async (event) => {
  await checkPayload(event.data);
  postMessage(event.data);
  close();
};
