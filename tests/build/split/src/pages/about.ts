import data from "./about.json";
export default function about(): string {
  return `<h1>${data.title}</h1>`;
}
