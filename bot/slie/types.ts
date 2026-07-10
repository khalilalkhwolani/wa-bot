export type IntentType = 'ASK_HELP' | 'SELL_SERVICE' | 'DISCUSSION' | 'THANKS' | 'UNKNOWN';

export interface SLIEMessage {
	id: string;
	remoteJid: string;
	participant: string;
	participantAlt?: string;
	pushName: string;
	text: string;
	quotedText?: string;
	timestamp: number;
	rawMessage?: any;
}

export interface SLIEContext {
	messages: SLIEMessage[];
	lastUpdated: number;
}

export interface UserBehavior {
	phone: string;
	pushName: string;
	helpRequestsCount: number;
	adsCount: number;
	trustScore: number; // 0.0 to 1.0
}

export interface DynamicRule {
	key: string;
	weight: number; // Positive for help, Negative for ads
	category: 'STUDY_NOUN' | 'HELP_VERB' | 'AD_KEYWORD';
}

export interface SLIEAnalysisResult {
	classification: IntentType;
	confidence: number; // 0.0 to 1.0;
	subject: string;
	category: string;
	urgency: 'High' | 'Medium' | 'Low';
	leadScore: number; // 0 - 100
	reason: string;
}

export interface SLIELead {
	id: string;
	studentPhone: string;
	studentName: string;
	originalGroup: string;
	messageContent: string;
	classification: IntentType;
	subject: string;
	score: number;
	confidence: number;
	createdAt: string;
	sentMessageId?: string;
}
