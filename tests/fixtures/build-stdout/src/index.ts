import { greet } from "./greet";
import data from "./data.json";
enum Mood { Happy = "happy", Sad = "sad" }
const mood: Mood = Mood.Happy;
console.log(greet(data.name), mood);
