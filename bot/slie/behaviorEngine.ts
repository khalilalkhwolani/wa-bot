import { UserBehavior } from './types';

/**
 * محرك سلوك المستخدمين (Engine 5: Behavior Engine)
 */

/**
 * حساب معامل الثقة الديناميكي للمرسل بناءً على تاريخه الإحصائي
 */
export function calculateUserTrust(behavior: UserBehavior): number {
	const total = behavior.helpRequestsCount + behavior.adsCount;
	if (total === 0) return 0.5; // قيمة محايدة افتراضية للمستخدم الجديد

	// معامل الثقة = (عدد طلبات الطلاب / إجمالي التفاعلات)
	let score = behavior.helpRequestsCount / total;

	// خصم نقاط عقابي إضافي إذا كان لديه أي سوابق إعلانية معلنة
	if (behavior.adsCount > 0) {
		score -= behavior.adsCount * 0.15;
	}

	return Math.max(0.0, Math.min(1.0, score));
}

/**
 * تحديث السجل السلوكي للمستخدم بناءً على تصنيف معتمد جديد
 */
export function updateBehaviorMetrics(
	current: UserBehavior,
	approvedAsHelp: boolean
): UserBehavior {
	const updated = { ...current };
	if (approvedAsHelp) {
		updated.helpRequestsCount += 1;
	} else {
		updated.adsCount += 1;
	}
	updated.trustScore = calculateUserTrust(updated);
	return updated;
}
