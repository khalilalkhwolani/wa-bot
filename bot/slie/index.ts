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
	const tag = phone;

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`📨 [SLIE] رسالة جديدة من: ${tag}`);
	console.log(`📝 النص (أول 50 حرف): "${message.text.slice(0, 50).replace(/\n/g, ' ')}${message.text.length > 50 ? '...' : ''}"`);
	console.log(`🔹 نتيجة النية المحلية : intent=${intent} | localScore=${localScore}`);
	console.log(`🔍 بصمة التنسيق    : isAd=${fingerprint.isAdPattern} | emojiLines=${fingerprint.emojiLinesCount} | bullets=${fingerprint.bulletPointsCount} | scoreReduction=-${fingerprint.scoreReduction} | wa.link=${fingerprint.hasDirectContactLink}`);
	console.log(`📊 تقييم المستخدم  : trustScore=${behavior.trustScore}`);
	console.log(`✅ الثقة النهائية  : confidence=${(confidence * 100).toFixed(1)}% | القرار=${routingDecision}`);

	if (routingDecision === 'REJECT') {
		console.log(`🚨 [SLIE] قرار: رفض محلي | السبب: بصمة إعلانية أو نقاط سلبية`);
		console.log(`${'═'.repeat(60)}\n`);
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
		console.log(`✨ [SLIE] قرار: تمرير مباشر (PASS) | المستخدم موثوق أو نقاط عالية`);
		console.log(`${'═'.repeat(60)}\n`);
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

	// 6. منطقة الشك: استدعاء الذكاء الاصطناعي (Groq)
	console.log(`🤖 [SLIE] قرار: منطقة رمادية → إرسال للذكاء الاصطناعي...`);
	try {
		const aiResult = await analyzeGrayZoneWithAI(message);
		const isHelp = aiResult.classification === 'HELP_REQUEST';
		console.log(`💡 [AI] النتيجة: ${aiResult.classification} | ثقة=${(aiResult.confidence * 100).toFixed(1)}% | المادة="${aiResult.subject}" | السبب: ${aiResult.reason}`);

		if (!isHelp) {
			console.log(`🚨 [AI] قرار: رفض (ليس طلب مساعدة)`);
			console.log(`${'═'.repeat(60)}\n`);
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

		// حتى لو قال النموذج إنها مساعدة، لا إرسال عند ثقة ضعيفة أو دليل محلي ضعيف.
		// تحفظ الحالة للمراجعة، منعاً لتمرير أي طلب بسيط أو نتيجة AI مترددة.
		if (aiResult.confidence < 0.9 || localScore < 25) {
			console.log(`⏸️ [AI] طلب محتمل لكن الدليل غير كافٍ للإرسال التلقائي`);
			console.log(`${'═'.repeat(60)}\n`);
			return {
				decision: 'REJECT',
				analysis: {
					classification: 'UNKNOWN',
					confidence: aiResult.confidence,
					subject: aiResult.subject,
					category: 'مراجعة داخلية بسبب انخفاض الثقة',
					urgency: aiResult.urgency,
					leadScore: aiResult.leadScore,
					reason: `لم يرسل: ثقة AI=${aiResult.confidence.toFixed(2)} والنقاط المحلية=${localScore}`
				}
			};
		}

		// حساب جودة الـ Lead الأكاديمي
		const qualityScore = calculateLeadQualityScore(message.text, aiResult.subject);
		console.log(`✅ [AI] قرار: تمرير (PASS) | LeadScore=${qualityScore}`);
		console.log(`${'═'.repeat(60)}\n`);

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
		// عند تعطل الذكاء الاصطناعي لا نقبل المنطقة الرمادية تلقائياً.
		// تحفظ لاحقاً للمراجعة فقط؛ هذا يمنع وصول الإعلانات على أنها طلبات.
		const qualityScore = calculateLeadQualityScore(message.text, 'غير محدد');
		console.log(`⚠️  [SLIE] فشل الذكاء الاصطناعي | النقاط المحلية=${localScore} → حفظ للمراجعة دون إرسال`);
		console.log(`${'═'.repeat(60)}\n`);
		return {
			decision: 'REJECT',
			analysis: {
				classification: 'UNKNOWN',
				confidence: 0,
				subject: 'غير محدد',
				category: 'مراجعة داخلية بسبب تعطل المصنف',
				urgency: 'Medium',
				leadScore: qualityScore,
				reason: `المصنف غير متاح؛ لم يُرسل شيء تلقائياً (النقاط المحلية: ${localScore})`
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
