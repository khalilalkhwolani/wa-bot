import { SLIEMessage } from './types';
import { hasAcademicHelpSignal } from '../services/ruleEngine';

/**
 * محرك الحوار والردود (Engine 4: Conversation Engine)
 */

export interface ConversationContextResult {
	isReply: boolean;
	quotedSender?: string;
	quotedText?: string;
	hasStudyContext: boolean;
	shouldContinue: boolean;
	reason: string;
}

/**
 * تحليل سياق الرد: الرد على دردشة غير دراسية يُستبعد حتى لو فيه كلمة عامة
 */
export function analyzeConversationContext(message: SLIEMessage): ConversationContextResult {
	const currentHasSignal = hasAcademicHelpSignal(message.text || '');
	const isReply = !!message.quotedText;

	if (!isReply) {
		return {
			isReply: false,
			hasStudyContext: false,
			shouldContinue: currentHasSignal,
			reason: currentHasSignal
				? 'رسالة مستقلة فيها إشارة طلب مساعدة أكاديمية'
				: 'رسالة مستقلة بلا إشارة دراسية'
		};
	}

	const hasStudyContext = hasAcademicHelpSignal(message.quotedText || '');

	if (!hasStudyContext && !currentHasSignal) {
		return {
			isReply: true,
			quotedText: message.quotedText,
			hasStudyContext: false,
			shouldContinue: false,
			reason: 'رد على رسالة غير دراسية بدون طلب مساعدة في النص الحالي'
		};
	}

	// رد قصير على واجب بدون أن يطلب المساعدة بنفسه («اي حتى انا كذا»)
	if (hasStudyContext && !currentHasSignal) {
		return {
			isReply: true,
			quotedText: message.quotedText,
			hasStudyContext: true,
			shouldContinue: false,
			reason: 'رد دردشة على سياق دراسي بدون طلب مساعدة في النص الحالي'
		};
	}

	return {
		isReply: true,
		quotedText: message.quotedText,
		hasStudyContext,
		shouldContinue: true,
		reason: hasStudyContext
			? 'رد على سياق دراسي مع طلب مساعدة في النص الحالي'
			: 'طلب مساعدة مستقل حتى لو كان رداً على رسالة أخرى'
	};
}
