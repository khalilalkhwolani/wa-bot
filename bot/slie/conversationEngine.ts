import { SLIEMessage } from './types';
import { shouldAnalyzeStudentLead } from '../services/ruleEngine';

/**
 * محرك الحوار والردود (Engine 4: Conversation Engine)
 */

export interface ConversationContextResult {
	isReply: boolean;
	quotedSender?: string;
	quotedText?: string;
	hasStudyContext: boolean;
}

/**
 * تحليل سياق الرد للمسجات لمعرفة هل الرد مرتبط بطلب دراسي أم رسالة مستقلة
 */
export function analyzeConversationContext(message: SLIEMessage): ConversationContextResult {
	const isReply = !!message.quotedText;
	
	if (!isReply) {
		return {
			isReply: false,
			hasStudyContext: false
		};
	}

	// تحقق من أن الرسالة المقتبسة الأصلية كانت تحتوي على سياق دراسي حقيقي
	const hasStudyContext = shouldAnalyzeStudentLead(message.quotedText || '');

	return {
		isReply: true,
		quotedText: message.quotedText,
		hasStudyContext
	};
}
