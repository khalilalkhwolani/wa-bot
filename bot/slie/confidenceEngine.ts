/**
 * محرك الثقة والقرار المحلي (Engine 7: Confidence Engine)
 */

export interface ConfidenceResult {
	confidence: number; // 0.0 to 1.0
	routingDecision: 'REJECT' | 'PASS' | 'AI_GRAY';
}

/**
 * حساب نسبة الثقة الدلالية المحلية وتحديد مسار المعالجة للرسالة
 */
export function calculateLocalConfidence(
	localScore: number,
	fingerprintReduction: number,
	userTrust: number
): ConfidenceResult {
	// 1. حساب النتيجة الأساسية بناءً على نقاط النية
	let score = localScore;

	// 2. تطبيق تأثير ثقة سلوك المستخدم
	if (userTrust > 0.8) {
		score += 15; // رفع النقاط إذا كان مستخدم موثوق ولديه طلبات سابقة معتمدة
	} else if (userTrust < 0.3) {
		score -= 30; // خفض عقابي للنقاط إذا كان مستخدم مشبوه
	}

	// 3. خصم نقاط التنسيق والبصمة الإعلانية
	score -= fingerprintReduction;

	// 4. تحديد النطاق بين 0 و 100
	const finalScore = Math.max(0, Math.min(100, score));

	// 5. اتخاذ القرار التوجيهي بناءً على النطاق
	let routingDecision: 'REJECT' | 'PASS' | 'AI_GRAY' = 'AI_GRAY';
	if (finalScore >= 85) {
		routingDecision = 'PASS';
	} else if (finalScore < 25) {
		routingDecision = 'REJECT';
	}

	return {
		confidence: finalScore / 100,
		routingDecision
	};
}
