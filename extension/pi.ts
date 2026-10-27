/**
 * The slice of pi's extension API this plugin uses.
 *
 * Declared structurally so the package needs no dependency on
 * `@earendil-works/pi-coding-agent`: pi supplies the real objects at runtime.
 */

export interface ExtensionTheme {
	fg(color: string, text: string): string;
}

export interface ExtensionTui {
	requestRender(force?: boolean): void;
}

export interface ExtensionComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
}

/**
 * Overlay layout. Without `width` pi caps overlays at 80 columns, so the plugin
 * asks for the width it needs to wrap a long verification URL.
 */
export interface ExtensionOverlayOptions {
	width?: number | string;
	maxHeight?: number | string;
	margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
	anchor?: string;
	row?: number | string;
	col?: number | string;
}

export interface ExtensionUI {
	notify(message: string, type?: 'info' | 'warning' | 'error'): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	setStatus(key: string, text: string | undefined): void;
	custom<T>(
		factory: (
			tui: ExtensionTui,
			theme: ExtensionTheme,
			keybindings: unknown,
			done: (result: T) => void,
		) => ExtensionComponent,
		options?: {
			overlay?: boolean;
			overlayOptions?: ExtensionOverlayOptions | (() => ExtensionOverlayOptions | undefined);
		},
	): Promise<T>;
}

export interface ExtensionCommandContext {
	ui: ExtensionUI;
	cwd: string;
	mode: 'tui' | 'rpc' | 'json' | 'print';
	hasUI: boolean;
}

export interface ExtensionAPI {
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (argumentPrefix: string) => { value: string; label: string }[] | null;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		},
	): void;
	on(
		event: 'session_start' | 'session_shutdown',
		handler: (event: unknown, ctx: ExtensionCommandContext) => void | Promise<void>,
	): () => void;
}
