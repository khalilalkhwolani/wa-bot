import { analyzeMessageWithAI, AIAnalysisResult } from '../services/gemini';
import { SLIEMessage } from './types';

/**
 * محرك التحليل بالذكاء الاصطناعي للحالات الرمادية (Engine 8: AI Analyzer)
 */

export async function analyzeGrayZoneWithAI(message: SLIEMessage): Promise<AIAnalysisResult> {
	// تمرير نص الرسالة مع سياق الرد المقتبس لحسم النية
	return analyzeMessageWithAI(message.text, message.quotedText);
}
