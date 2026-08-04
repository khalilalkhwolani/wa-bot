import { SLIEMessage, SLIEAnalysisResult } from './types';
import { normalizeArabicText } from './normalizer';
import { classifyIntentLocally } from './intentEngine';
import { calculateLocalConfidence } from './confidenceEngine';
import { analyzeGrayZoneWithAI } from './aiAnalyzer';
import { calculateLeadQualityScore } from './leadQualityScorer';
import { analyzeStructuralFingerprint } from './fingerprintEngine';
import { shouldAnalyzeStudentLead } from '../services/ruleEngine';
import { evaluateLead } from '../services/scorer';
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
	const tag = message.participant.split('@')[0].split(':')[0];

	// 1b. بوابة محلية سريعة: لا ندخل الأنبوب إلا إذا وُجدت إشارات طلب مساعدة حقيقية
	const textForGate = `${message.text} ${message.quotedText || ''}`.trim();
	if (!shouldAnalyzeStudentLead(textForGate) && !shouldAnalyzeStudentLead(normalizedText)) {
		console.log(`\n${'═'.repeat(60)}`);
		console.log(`📨 [SLIE] رسالة جديدة من: ${tag}`);
		console.log(`🚨 [SLIE] قرار: رفض مبكر | لا توجد إشارات طلب مساعدة أكاديمية`);
		console.log(`${'═'.repeat(60)}\n`);
		return {
			decision: 'REJECT',
			analysis: {
				classification: 'DISCUSSION',
				confidence: 0,
				subject: 'غير محدد',
				category: 'تصفية مبكرة',
				urgency: 'Low',
				leadScore: 0,
				reason: 'لا توجد إشارات كافية لطلب مساعدة أكاديمية (فلتر محلي مبكر)'
			}
		};
	}

	// 2. استخراج سلوك المستخدم ورقم الهاتف
	const phone = tag;
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

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`📨 [SLIE] رسالة جديدة من: ${tag}`);
	console.log(`📝 النص (أول 50 حرف): "${message.text.slice(0, 50).replace(/\n/g, ' ')}${message.text.length > 50 ? '...' : ''}"`);
	console.log(`🔹 نتيجة النية المحلية : intent=${intent} | localScore=${localScore}`);
	console.log(`🔍 بصمة التنسيق    : isAd=${fingerprint.isAdPattern} | emojiLines=${fingerprint.emojiLinesCount} | bullets=${fingerprint.bulletPointsCount} | scoreReduction=-${fingerprint.scoreReduction} | wa.link=${fingerprint.hasDirectContactLink}`);
	console.log(`📊 تقييم المستخدم  : trustScore=${behavior.trustScore}`);
	console.log(`✅ الثقة النهائية  : confidence=${(confidence * 100).toFixed(1)}% | القرار=${routingDecision}`);

	if (routingDecision === 'REJECT') {
		console.log(`🚨 [SLIE] قرار: رفض محلي | السبب: بصمة إعلانية أو نقاط منخفضة`);
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

	// تمرير مباشر فقط إذا النية ASK_HELP مؤكدة محلياً
	if (routingDecision === 'PASS' && intent === 'ASK_HELP') {
		console.log(`✨ [SLIE] قرار: تمرير مباشر (PASS) | نية مساعدة مؤكدة ونقاط عالية`);
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

	// إن كانت النقاط عالية لكن النية ليست ASK_HELP → أرسل للـ AI بدل التمرير الأعمى
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

		const qualityScore = calculateLeadQualityScore(message.text, aiResult.subject);
		const scored = evaluateLead({
			...aiResult,
			leadScore: Math.max(qualityScore, aiResult.leadScore || 0)
		});

		if (!scored.shouldNotify) {
			console.log(`🚨 [AI] قرار: رفض بعد تقييم الجودة | ${scored.reason}`);
			console.log(`${'═'.repeat(60)}\n`);
			return {
				decision: 'REJECT',
				analysis: {
					classification: 'DISCUSSION',
					confidence: aiResult.confidence,
					subject: aiResult.subject,
					category: aiResult.category,
					urgency: aiResult.urgency,
					leadScore: qualityScore,
					reason: scored.reason
				}
			};
		}

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
		// Fallback صارم: لا نمرّر إلا مع نية مساعدة ونقاط مرتفعة
		const qualityScore = calculateLeadQualityScore(message.text, 'غير محدد');
		const isLikelyHelp = intent === 'ASK_HELP' && localScore >= 45;
		console.log(`⚠️  [SLIE] فشل كلا AI | النقاط المحلية=${localScore} intent=${intent} → Fallback: ${isLikelyHelp ? 'PASS' : 'REJECT'}`);
		console.log(`${'═'.repeat(60)}\n`);
		return {
			decision: isLikelyHelp ? 'PASS' : 'REJECT',
			analysis: {
				classification: isLikelyHelp ? 'ASK_HELP' : 'DISCUSSION',
				confidence: 0.5,
				subject: isLikelyHelp ? 'غير محدد' : 'معلق بسبب انقطاع الخدمة',
				category: isLikelyHelp ? 'Fallback محلي' : 'Fallback مرفوض',
				urgency: 'Medium',
				leadScore: qualityScore,
				reason: isLikelyHelp
					? `تم التمرير احتياطياً لوجود مؤشرات طلب مساعدة قوية (نقاط: ${localScore}) - الذكاء الاصطناعي غير متاح حالياً`
					: `تم الرفض لعدم كفاية المؤشرات (نقاط: ${localScore}) - الذكاء الاصطناعي غير متاح حالياً`
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
