import fs from 'fs'
import path from 'path'
import { UserBehavior, DynamicRule } from '../slie/types'

export interface Lead {
	id: string
	studentPhone: string
	studentName: string
	originalGroup: string
	messageContent: string
	classification: string
	subject: string
	score: number
	confidence: number
	createdAt: string
	sentMessageId?: string
}

class JsonDatabase {
	private filePath = path.join('sessions', 'leads_database.json')
	private leads: Lead[] = []
	private behaviors: { [phone: string]: UserBehavior } = {}
	private dynamicRules: DynamicRule[] = []

	constructor() {
		this.load()
	}

	/**
	 * تحميل البيانات من ملف JSON المستقر على القرص بمرونة كاملة
	 */
	private load() {
		try {
			if (fs.existsSync(this.filePath)) {
				const raw = fs.readFileSync(this.filePath, 'utf-8')
				const parsed = JSON.parse(raw)
				if (Array.isArray(parsed)) {
					this.leads = parsed
				} else {
					this.leads = parsed.leads || []
					this.behaviors = parsed.behaviors || {}
					this.dynamicRules = parsed.dynamicRules || []
				}
			}
		} catch (err) {
			console.error('❌ فشل تحميل قاعدة البيانات المحلية:', err)
			this.leads = []
			this.behaviors = {}
			this.dynamicRules = []
		}
	}

	/**
	 * حفظ البيانات بأمان وكتابتها على القرص
	 */
	private save() {
		try {
			const dir = path.dirname(this.filePath)
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true })
			}
			const payload = {
				leads: this.leads,
				behaviors: this.behaviors,
				dynamicRules: this.dynamicRules
			}
			fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8')
		} catch (err) {
			console.error('❌ فشل حفظ التحديثات في قاعدة البيانات:', err)
		}
	}

	/**
	 * إدخال Lead جديد وحفظه
	 */
	public async insertLead(lead: Omit<Lead, 'id' | 'createdAt'>): Promise<Lead> {
		const newLead: Lead = {
			...lead,
			id: 'LD-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
			createdAt: new Date().toISOString()
		}
		this.leads.push(newLead)
		this.save()
		return newLead
	}

	/**
	 * جلب كافة الـ Leads المحفوظة
	 */
	public async getLeads(): Promise<Lead[]> {
		return this.leads
	}

	/**
	 * تحديث معرف رسالة التنبيه المرسلة لربط التفاعلات التلقائية
	 */
	public async updateLeadSentMessageId(leadId: string, sentMessageId: string): Promise<void> {
		const lead = this.leads.find(l => l.id === leadId)
		if (lead) {
			lead.sentMessageId = sentMessageId
			this.save()
		}
	}

	/**
	 * فحص ما إذا كان نص الرسالة قد تم توجيهه وحفظه مسبقاً لنفس رقم الطالب (Duplicate Prevention)
	 */
	public async hasLead(phone: string, messageContent: string): Promise<boolean> {
		if (!messageContent) return false
		const cleaned = messageContent.trim().toLowerCase()
		return this.leads.some(l => l.studentPhone === phone && l.messageContent.trim().toLowerCase() === cleaned)
	}

	/**
	 * جلب السجل السلوكي للمستخدم
	 */
	public async getUserBehavior(phone: string): Promise<UserBehavior> {
		if (!this.behaviors[phone]) {
			this.behaviors[phone] = {
				phone,
				pushName: 'غير مسجل',
				helpRequestsCount: 0,
				adsCount: 0,
				trustScore: 0.5
			}
		}
		return this.behaviors[phone]
	}

	/**
	 * حفظ سلوك المستخدم
	 */
	public async saveUserBehavior(behavior: UserBehavior): Promise<void> {
		this.behaviors[behavior.phone] = behavior
		this.save()
	}

	/**
	 * جلب القوانين الديناميكية للتعلم
	 */
	public async getDynamicRules(): Promise<DynamicRule[]> {
		return this.dynamicRules
	}

	/**
	 * حفظ أو تحديث قانون ديناميكي
	 */
	public async saveDynamicRule(rule: DynamicRule): Promise<void> {
		const idx = this.dynamicRules.findIndex(r => r.key === rule.key)
		if (idx >= 0) {
			this.dynamicRules[idx] = rule
		} else {
			this.dynamicRules.push(rule)
		}
		this.save()
	}
}

// تصدير كائن قاعدة بيانات أحادي (Singleton Pattern)
export const db = new JsonDatabase()
