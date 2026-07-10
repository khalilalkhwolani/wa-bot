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

			const firstMsg = existing.messages[0];
			const totalDuration = message.timestamp - firstMsg.timestamp;

			// إذا تجاوز التجميع 4 رسائل أو مر أكثر من 30 ثانية على أول رسالة، نقوم بالإرسال فوراً
			if (existing.messages.length >= 4 || totalDuration >= 30000) {
				this.flush(key, onFlush);
			} else {
				const timer = setTimeout(() => {
					this.flush(key, onFlush);
				}, this.debounceMs);

				this.buffers.set(key, { messages: existing.messages, timer });
			}
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

		// مسح المؤقت لمنع الاستدعاء المزدوج في حال تم الإرسال الفوري يدوياً
		clearTimeout(data.timer);
		this.buffers.delete(key);

		const messages = data.messages;
		if (messages.length === 0) return;

		// استخدام أول رسالة كأساس للمرجع والخصائص
		const base = messages[0];
		
		// دمج كافة نصوص الرسائل المتتالية بصيغة أسطر مع تمييز الرسائل التي تحتوي على ردود
		const formattedLines = messages.map(m => {
			const text = m.text.trim();
			if (!text) return '';
			// إذا كانت هذه الرسالة عبارة عن رد على رسالة أخرى، نميزها بـ ↪️، وإلا بـ ▫️
			return m.quotedText ? `↪️ ${text}` : `▫️ ${text}`;
		}).filter(line => line.length > 0);
		
		const combinedText = formattedLines.join('\n');

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
