import { SLIEMessage, SLIEAnalysisResult } from './types';
import { normalizeArabicText } from './normalizer';
import { classifyIntentLocally } from './intentEngine';
import { analyzeConversationContext } from './conversationEngine';
import { calculateLocalConfidence } from './confidenceEngine';
import { analyzeGrayZoneWithAI } from './aiAnalyzer';
import { calculateLeadQualityScore } from './leadQualityScorer';
import { analyzeStructuralFingerprint } from './fingerprintEngine';
import { db } from '../database/database';

/**
 * المنسق الرئيسي لأنابيب محرك SLIE (Pipeline Orchestrator)
 */
export async function runSLIEPipeline(message: SLIEMessage): Promise<{
	decision: 'PASS' | 'REJECT';
	analysis: SLIEAnalysisResult;
}> {
	// 1. تطهير النص محلياً
	const normalizedText = normalizeArabicText(message.text);

	// 2. استخراج سلوك المستخدم ورقم الهاتف
	const phone = message.participant.split('@')[0].split(':')[0];
	const behavior = await db.getUserBehavior(phone);
	const dynamicRules = await db.getDynamicRules();

	// 3. تحليل النية محلياً
	const { intent, localScore } = classifyIntentLocally(normalizedText, dynamicRules);

	// 4. تحليل البصمة الهيكلية للرسالة
	const fingerprint = analyzeStructuralFingerprint(message.text);

	// 5. حساب الثقة والقرار التوجيهي المحلي
	const { confidence, routingDecision } = calculateLocalConfidence(
		localScore,
		fingerprint.scoreReduction,
		behavior.trustScore
	);

	// حالة الرفض الصارم الفوري
	if (routingDecision === 'REJECT') {
		return {
			decision: 'REJECT',
			analysis: {
				classification: intent,
				confidence,
				subject: 'غير محدد',
				category: 'تصفية محلية',
				urgency: 'Low',
				leadScore: localScore,
				reason: 'تم الحظر تلقائياً في المرحلة المحلية (بصمة إعلانية أو نقاط منخفضة)'
			}
		};
	}

	// حالة التمرير المباشر دون AI (لتوفير التكلفة للموثوقين)
	if (routingDecision === 'PASS') {
		const qualityScore = calculateLeadQualityScore(message.text, 'غير محدد');
		return {
			decision: 'PASS',
			analysis: {
				classification: 'ASK_HELP',
				confidence,
				subject: 'غير محدد',
				category: 'طالب مؤكد',
				urgency: 'Medium',
				leadScore: qualityScore,
				reason: 'تم التمرير المباشر محلياً لثقة النقاط العالية'
			}
		};
	}

	// 6. منطقة الشك: استدعاء الذكاء الاصطناعي (Gemini)
	try {
		const aiResult = await analyzeGrayZoneWithAI(message);
		const isHelp = aiResult.classification === 'HELP_REQUEST';

		if (!isHelp) {
			return {
				decision: 'REJECT',
				analysis: {
					classification: 'SELL_SERVICE',
					confidence: aiResult.confidence,
					subject: aiResult.subject,
					category: aiResult.category,
					urgency: aiResult.urgency,
					leadScore: aiResult.leadScore,
					reason: aiResult.reason
				}
			};
		}

		// حساب جودة الـ Lead الأكاديمي
		const qualityScore = calculateLeadQualityScore(message.text, aiResult.subject);

		return {
			decision: 'PASS',
			analysis: {
				classification: 'ASK_HELP',
				confidence: aiResult.confidence,
				subject: aiResult.subject,
				category: aiResult.category,
				urgency: aiResult.urgency,
				leadScore: qualityScore,
				reason: aiResult.reason
			}
		};
	} catch (err) {
		// نظام الـ Fallback عند تعطل الـ API
		const qualityScore = calculateLeadQualityScore(message.text, 'غير محدد');
		return {
			decision: 'PASS', // نمررها كوقاية لكي لا يضيع طلب الطالب
			analysis: {
				classification: 'ASK_HELP',
				confidence: 0.5,
				subject: 'معلق بسبب انقطاع الخدمة',
				category: 'Fallback',
				urgency: 'Medium',
				leadScore: qualityScore,
				reason: `تم التمرير الوقائي بسبب تعطل الـ AI: ${err}`
			}
		};
	}
}
export * from './types';
export * from './normalizer';
export * from './contextBuilder';
export * from './intentEngine';
export * from './conversationEngine';
export * from './behaviorEngine';
export * from './fingerprintEngine';
export * from './confidenceEngine';
export * from './aiAnalyzer';
export * from './leadQualityScorer';
export * from './learningEngine';
