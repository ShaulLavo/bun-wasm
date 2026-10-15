declare module "*websocket.js" {
  const factory: (internal: object) => { clientClass(connection: unknown): typeof WebSocket };
  export default factory;
}
