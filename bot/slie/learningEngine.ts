import { db } from '../database/database';
import { updateBehaviorMetrics } from './behaviorEngine';
import { normalizeArabicText } from './normalizer';

/**
 * محرك التعلم والتصحيح الذاتي (Engine 10: Learning Engine)
 */

/**
 * معالجة التغذية الراجعة من المشرفين وتعديل معاملات البوت تلقائياً
 */
export async function processModeratorFeedback(
	studentPhone: string,
	messageContent: string,
	isTrueHelp: boolean
): Promise<void> {
	// 1. جلب السجل السلوكي الحالي للمرسل
	const behavior = await db.getUserBehavior(studentPhone);

	// 2. تحديث السجل وحساب معامل الثقة الجديد
	const updatedBehavior = updateBehaviorMetrics(behavior, isTrueHelp);
	await db.saveUserBehavior(updatedBehavior);

	// 3. التعلم الذاتي: إذا كانت الرسالة إعلاناً كاذباً (مرت بالخطأ وتم حجبها بشرياً)
	if (!isTrueHelp && messageContent) {
		const normalized = normalizeArabicText(messageContent);
		// تقسيم الجملة إلى كلمات بطول أكبر من أو يساوي 4 حروف
		const words = normalized
			.split(/\s+/)
			.map(word => word.trim())
			.filter(word => word.length >= 4);

		// إضافة الكلمات الجديدة لقائمة الكلمات المحظورة ديناميكياً بوزن سلبي (-15)
		for (const word of words) {
			// نتجنب الكلمات الشائعة جداً
			if (['الله', 'شباب', 'يا شباب', 'السلام', 'عليكم'].includes(word)) {
				continue;
			}
			await db.saveDynamicRule({
				key: word,
				weight: -15,
				category: 'AD_KEYWORD'
			});
		}
	}
}
