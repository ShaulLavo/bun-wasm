import { installAtomicsObservers } from "./engine-interruption-atomics";

// No static import of the page/probe/runtime closure may precede this setup.
installAtomicsObservers();
await import("./engine-interruption-main");
