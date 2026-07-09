import fs from 'fs'
import path from 'path'

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
}

class JsonDatabase {
	private filePath = path.join('sessions', 'leads_database.json')
	private leads: Lead[] = []

	constructor() {
		this.load()
	}

	/**
	 * تحميل البيانات من ملف JSON المستقر على القرص
	 */
	private load() {
		try {
			if (fs.existsSync(this.filePath)) {
				const data = fs.readFileSync(this.filePath, 'utf-8')
				this.leads = JSON.parse(data)
			}
		} catch (err) {
			console.error('❌ فشل تحميل قاعدة البيانات المحلية:', err)
			this.leads = []
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
			fs.writeFileSync(this.filePath, JSON.stringify(this.leads, null, 2), 'utf-8')
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
	 * فحص ما إذا كان نص الرسالة قد تم توجيهه وحفظه مسبقاً لمنع التكرار (Duplicate Prevention)
	 */
	public async hasLead(messageContent: string): Promise<boolean> {
		if (!messageContent) return false
		const cleaned = messageContent.trim().toLowerCase()
		return this.leads.some(l => l.messageContent.trim().toLowerCase() === cleaned)
	}
}

// تصدير كائن قاعدة بيانات أحادي (Singleton Pattern)
export const db = new JsonDatabase()
