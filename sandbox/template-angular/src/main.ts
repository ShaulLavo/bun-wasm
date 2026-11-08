import { Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";

@Component({
  selector: "app-root",
  template: `<h1 id="message">Hello from angular</h1>
    <button id="increment" (click)="count.set(count() + 1)">Increment</button>
    <output id="count">{{ count() }}</output>`,
})
class App { readonly count = signal(0); }

void bootstrapApplication(App, { providers: [provideZonelessChangeDetection()] });
