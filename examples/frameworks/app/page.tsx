import { frameworks } from "../names";
export default function Home() {
  return <main><h1>Five frameworks, one Next app</h1><ul>{frameworks.map(name => <li key={name}><a href={`framework/${name}`}>{name}</a></li>)}</ul></main>;
}
