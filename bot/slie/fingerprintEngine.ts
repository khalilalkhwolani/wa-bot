/**
 * محرك البصمة الهيكلية للإعلان (Engine 6: Fingerprint Engine)
 */

export interface FingerprintAnalysis {
	isAdPattern: boolean;
	emojiLinesCount: number;
	hasDirectContactLink: boolean;
	bulletPointsCount: number;
	scoreReduction: number;
}

/**
 * فحص بصمة هيكل النص (الأشكال والتنسيق والقوائم النقطية) لكشف الإعلانات
 */
export function analyzeStructuralFingerprint(text: string): FingerprintAnalysis {
	if (!text) {
		return {
			isAdPattern: false,
			emojiLinesCount: 0,
			hasDirectContactLink: false,
			bulletPointsCount: 0,
			scoreReduction: 0
		};
	}

	let scoreReduction = 0;

	// 1. فحص روابط الواتساب الترويجية للتواصل المباشر
	const contactRegex = /wa\.me|wa\.link|api\.whatsapp\.com\/send|chat\.whatsapp\.com/gi;
	const hasDirectContactLink = contactRegex.test(text);
	if (hasDirectContactLink) {
		scoreReduction += 40;
	}

	// 2. تعداد الأسطر النقطية التي تبدأ برموز تعبيرية ومؤشرات
	const lines = text.split('\n');
	let emojiLinesCount = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed) {
			if (/^[\p{Emoji}\p{Extended_Pictographic}♦️🔹🔸📌✅☑️✔️•\-*]/u.test(trimmed)) {
				emojiLinesCount++;
			}
		}
	}

	if (emojiLinesCount >= 3) {
		scoreReduction += 35;
	}

	// 3. تعداد القوائم النقطية العامة
	const bulletPointsCount = (text.match(/[♦️🔹🔸📌✅•\-*]/g) || []).length;
	if (bulletPointsCount >= 4) {
		scoreReduction += 20;
	}

	// 4. تحديد ما إذا كان الهيكل العام يطابق بصمة إعلانية مؤكدة
	const isAdPattern = scoreReduction >= 35 || emojiLinesCount >= 4 || bulletPointsCount >= 6;

	return {
		isAdPattern,
		emojiLinesCount,
		hasDirectContactLink,
		bulletPointsCount,
		scoreReduction
	};
}
