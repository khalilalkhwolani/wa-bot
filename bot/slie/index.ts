import { SLIEMessage, SLIEAnalysisResult } from './types';
import { normalizeArabicText } from './normalizer';
import { classifyIntentLocally } from './intentEngine';
import { analyzeConversationContext } from './conversationEngine';
import { calculateLocalConfidence } from './confidenceEngine';
import { analyzeGrayZoneWithAI } from './aiAnalyzer';
import { calculateLeadQualityScore } from './leadQualityScorer';
import { analyzeStructuralFingerprint } from './fingerprintEngine';
import { passesStructuralLeadGate, hasAcademicHelpSignal } from '../services/ruleEngine';
import { evaluateLead } from '../services/scorer';
import { db } from '../database/database';

function rejectResult(
	classification: SLIEAnalysisResult['classification'],
	reason: string,
	confidence = 0,
	leadScore = 0
): { decision: 'REJECT'; analysis: SLIEAnalysisResult } {
	return {
		decision: 'REJECT',
		analysis: {
			classification,
			confidence,
			subject: 'غير محدد',
			category: 'تصفية طبقية',
			urgency: 'Low',
			leadScore,
			reason
		}
	};
}

/**
 * المنسق الرئيسي لأنابيب محرك SLIE (Pipeline Orchestrator)
 */
export async function runSLIEPipeline(message: SLIEMessage): Promise<{
	decision: 'PASS' | 'REJECT';
	analysis: SLIEAnalysisResult;
}> {
	const normalizedText = normalizeArabicText(message.text);
	const tag = message.participant.split('@')[0].split(':')[0];
	const combinedForGate = `${message.text} ${message.quotedText || ''}`.trim();

	// طبقة أ: هيكل رخيص
	if (!passesStructuralLeadGate(combinedForGate) && !passesStructuralLeadGate(message.text)) {
		console.log(`\n${'═'.repeat(60)}`);
		console.log(`📨 [SLIE] رسالة جديدة من: ${tag}`);
		console.log(`🚨 [SLIE] طبقة أ: رفض هيكلي`);
		console.log(`${'═'.repeat(60)}\n`);
		return rejectResult('DISCUSSION', 'رفض هيكلي (رابط/إعلان/رسالة قصيرة أو فارغة)');
	}

	// طبقة ب: إشارات أكاديمية في النص أو المقتبس
	const currentSignal = hasAcademicHelpSignal(message.text);
	const quotedSignal = hasAcademicHelpSignal(message.quotedText || '');
	if (!currentSignal && !quotedSignal) {
		console.log(`\n${'═'.repeat(60)}`);
		console.log(`📨 [SLIE] رسالة جديدة من: ${tag}`);
		console.log(`🚨 [SLIE] طبقة ب: صفر إشارات أكاديمية`);
		console.log(`${'═'.repeat(60)}\n`);
		return rejectResult('DISCUSSION', 'لا توجد إشارات طلب مساعدة أكاديمية في النص أو المقتبس');
	}

	// طبقة ج: سياق المحادثة
	const conversation = analyzeConversationContext(message);
	if (!conversation.shouldContinue) {
		console.log(`\n${'═'.repeat(60)}`);
		console.log(`📨 [SLIE] رسالة جديدة من: ${tag}`);
		console.log(`🚨 [SLIE] طبقة ج: ${conversation.reason}`);
		console.log(`${'═'.repeat(60)}\n`);
		return rejectResult('DISCUSSION', conversation.reason);
	}

	const phone = tag;
	const behavior = await db.getUserBehavior(phone);
	const dynamicRules = await db.getDynamicRules();
	const { intent, localScore } = classifyIntentLocally(normalizedText, dynamicRules);
	const fingerprint = analyzeStructuralFingerprint(message.text);
	const { confidence, routingDecision } = calculateLocalConfidence(
		localScore,
		fingerprint.scoreReduction,
		behavior.trustScore
	);

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`📨 [SLIE] رسالة جديدة من: ${tag}`);
	console.log(`📝 النص (أول 50 حرف): "${message.text.slice(0, 50).replace(/\n/g, ' ')}${message.text.length > 50 ? '...' : ''}"`);
	console.log(`🔹 نتيجة النية المحلية : intent=${intent} | localScore=${localScore}`);
	console.log(`💬 سياق الحوار     : ${conversation.reason}`);
	console.log(`🔍 بصمة التنسيق    : isAd=${fingerprint.isAdPattern} | emojiLines=${fingerprint.emojiLinesCount} | bullets=${fingerprint.bulletPointsCount} | scoreReduction=-${fingerprint.scoreReduction} | wa.link=${fingerprint.hasDirectContactLink}`);
	console.log(`📊 تقييم المستخدم  : trustScore=${behavior.trustScore}`);
	console.log(`✅ الثقة النهائية  : confidence=${(confidence * 100).toFixed(1)}% | القرار=${routingDecision}`);

	if (routingDecision === 'REJECT') {
		console.log(`🚨 [SLIE] قرار: رفض محلي | نقاط منخفضة أو بصمة إعلانية`);
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
				reason: 'تم التمرير المباشر محلياً لثقة النقاط العالية ونية ASK_HELP'
			}
		};
	}

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
