onmessage = event => {
  postMessage(event.data);
  onmessage = null;
};
