import "./global.css";
import { Button } from "./components/Button";
import { formatCount, VERSION } from "tiny-format";
import leftPad from "cjs-lib";
import { greet } from "@scope/pkg";
import config from "./config.json";
import { name as appName } from "./config.json";

enum Mode {
  Light = "light",
  Dark = "dark",
}

interface Props {
  count: number;
  mode?: Mode;
}

export function App({ count, mode = Mode.Light }: Props) {
  const label: string = formatCount(count);
  return (
    <main className={`app ${mode}`}>
      <h1>{greet(appName)}</h1>
      <p>{leftPad(String(count), config.width)}</p>
      <Button onClick={() => console.log(label)}>Clicked {label}</Button>
      <>
        <span>v{VERSION}</span>
      </>
    </main>
  );
}

export default App;
console.log(App({ count: config.initial }));
