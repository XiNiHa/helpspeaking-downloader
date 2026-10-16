import { Runtime } from "foldkit";
import { registerSW } from "virtual:pwa-register";
import { Message } from "./message";
import { Flags, flags, Model } from "./model";
import { subscriptions } from "./subscription";
import { init, update } from "./update";
import { view } from "./view";

registerSW({ immediate: true });

const application = Runtime.makeApplication({
	Model,
	Flags,
	init,
	update,
	view,
	subscriptions,
	container: document.getElementById("root"),
	devTools: { Message },
});

Runtime.run(application, { flags });
