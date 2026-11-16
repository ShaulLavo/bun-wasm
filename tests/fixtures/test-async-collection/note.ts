export const note = (value: string) => console.log("event:" + value);
export const delay = () => new Promise<void>(resolve => setTimeout(resolve, 1));
