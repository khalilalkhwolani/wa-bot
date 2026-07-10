import { SLIEMessage } from './types';

/**
 * محرك تجميع الرسائل المتتالية (Engine 2: Context Builder)
 */
class ContextBuilder {
	private buffers = new Map<string, { messages: SLIEMessage[]; timer: NodeJS.Timeout }>();
	private debounceMs = 10000; // نافذة التجميع: 10 ثوانٍ

	/**
	 * إضافة رسالة للمؤقت وتأخير المعالجة لتجميع الرسائل المتتالية
	 */
	public addMessage(message: SLIEMessage, onFlush: (combined: SLIEMessage) => void) {
		const key = `${message.remoteJid}_${message.participant}`;
		const existing = this.buffers.get(key);

		if (existing) {
			clearTimeout(existing.timer);
			existing.messages.push(message);

			const timer = setTimeout(() => {
				this.flush(key, onFlush);
			}, this.debounceMs);

			this.buffers.set(key, { messages: existing.messages, timer });
		} else {
			const timer = setTimeout(() => {
				this.flush(key, onFlush);
			}, this.debounceMs);

			this.buffers.set(key, { messages: [message], timer });
		}
	}

	/**
	 * دمج النصوص والرسائل المفرقة للعميل عند انتهاء النافذة الزمنية
	 */
	private flush(key: string, onFlush: (combined: SLIEMessage) => void) {
		const data = this.buffers.get(key);
		if (!data) return;

		this.buffers.delete(key);

		const messages = data.messages;
		if (messages.length === 0) return;

		// استخدام أول رسالة كأساس للمرجع والخصائص
		const base = messages[0];
		
		// دمج كافة نصوص الرسائل المتتالية بفواصل مسافات
		const combinedText = messages.map(m => m.text.trim()).filter(t => t.length > 0).join(' ');

		// دمج الرسائل المقتبسة إن وجدت
		const quotedTexts = messages.map(m => m.quotedText).filter(Boolean) as string[];
		const combinedQuoted = quotedTexts.length > 0 ? quotedTexts[0] : undefined;

		const combinedMessage: SLIEMessage = {
			...base,
			text: combinedText,
			quotedText: combinedQuoted,
			timestamp: messages[messages.length - 1].timestamp // تحديث وقت الإرسال لأحدث رسالة
		};

		onFlush(combinedMessage);
	}
}

export const contextBuilder = new ContextBuilder();
