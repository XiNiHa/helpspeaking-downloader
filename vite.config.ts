import { cloudflare } from "@cloudflare/vite-plugin";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const clientOnly = (plugin: Plugin): Plugin => ({
	...plugin,
	applyToEnvironment: (environment) => environment.name === "client",
});

// NOTE: Foldkit's view-identity transform wraps every function's return value,
// which breaks the Worker's `page.evaluate` callbacks that run inside Chrome.
const foldkitPlugins = foldkit().map((plugin) =>
	plugin.name === "foldkit:view-identity" ? clientOnly(plugin) : plugin,
);

// NOTE: vite-plugin-pwa is not Environment-API aware and would also emit its
// registration script and manifest into the Worker build.
const pwaPlugins = VitePWA({
	injectRegister: null,
	registerType: "autoUpdate",
	includeAssets: ["icon.svg"],
	manifest: {
		name: "언어발전소",
		short_name: "언어발전소",
		start_url: "/",
		display: "standalone",
		background_color: "#09090b",
		theme_color: "#0284c7",
		icons: [
			{ src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
			{ src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
		],
	},
	workbox: {
		navigateFallback: "/index.html",
		navigateFallbackDenylist: [/^\/api(\/|$)/],
		globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
	},
}).map(clientOnly);

export default defineConfig({
	plugins: [cloudflare(), tailwindcss(), ...foldkitPlugins, ...pwaPlugins],
	optimizeDeps: { entries: ["src/app/entry.ts"] },
});
