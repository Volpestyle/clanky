declare module "qrcode" {
	export type QRCodeToStringOptions = {
		readonly small?: boolean;
		readonly type?: "terminal" | "utf8" | "svg";
	};

	const QRCode: {
		toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
	};

	export default QRCode;
}
