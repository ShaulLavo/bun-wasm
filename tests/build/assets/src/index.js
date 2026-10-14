import dot from "./img/dot.png";
import logo from "./img/logo.svg";
import notes from "./notes.txt";
import data from "./data.toml";
import "./style.css";

document.body.innerHTML = `<img src="${dot}"><img src="${logo}"><pre>${notes}</pre>${data.owner.name}`;
