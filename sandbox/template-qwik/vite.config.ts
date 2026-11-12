import { defineConfig } from "vite";
import { qwikVite } from "@builder.io/qwik/optimizer";
export default defineConfig(({ isPreview }) => ({ plugins: isPreview ? [] : [qwikVite({ csr: true })] }));
