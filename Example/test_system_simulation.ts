import { isSpamLinkText } from '../bot/services/ruleEngine'
import { runSLIEPipeline, SLIEMessage } from '../bot/slie'
import { db } from '../bot/database/database'

async function runComprehensiveVerification() {
	console.log('====================================================')
	console.log('🧪 بدء الفحص الشامل والمحاكاة لجميع أنظمة ومحركات البوت')
	console.log('====================================================\n')

	let passedTests = 0
	let totalTests = 0

	// 1. اختبار استخراج وتصفية روابط مجموعات واتساب
	totalTests++
	console.log('--- [اختبار 1] محرك تصفية واستخراج الروابط (Link Extractor & Filter) ---')
	const sampleTextWithLinks = 'تفضلوا بالانضمام إلى مجموعة العمل الخاصة بنا: https://chat.whatsapp.com/AbCdEfGhIjK1234567890'
	const groupLinkRegex = /https:\/\/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9]+)/gi
	const extractedLinks: string[] = []
	let match
	while ((match = groupLinkRegex.exec(sampleTextWithLinks)) !== null) {
		extractedLinks.push(match[0])
	}

	const isSpam = isSpamLinkText(sampleTextWithLinks)
	console.log(`🔗 الرابط المستخرج: ${extractedLinks.join(', ')}`)
	console.log(`🛡️ هل تم تصنيفه كرسالة مزعجة (Spam)؟ ${isSpam ? 'نعم ❌' : 'لا (رابط موثوق) ✅'}`)
	if (extractedLinks.length > 0 && !isSpam) {
		console.log('RESULT: PASSED ✅\n')
		passedTests++
	} else {
		console.log('RESULT: FAILED ❌\n')
	}

	// 2. اختبار محرك SLIE الذكي لتصنيف طلبات الطلاب وتمريره عبر نماذج الذكاء الاصطناعي
	totalTests++
	console.log('--- [اختبار 2] أنبوب التصنيف والذكاء الاصطناعي SLIE Engine ---')
	const testStudentMsg: SLIEMessage = {
		id: 'TEST_MSG_999',
		remoteJid: '120363198538942299@g.us',
		participant: '967770000000@s.whatsapp.net',
		pushName: 'طالب تجريبي',
		text: 'السلام عليكم أريد شخص متخصص يساعدني في حل واجب مادة برمجيات وتطبيقات الهاتف الذكي C++ ضروري جداً',
		quotedText: '',
		timestamp: Date.now()
	}

	console.log(`📩 نص الرسالة التجريبية: "${testStudentMsg.text}"`)
	console.log('🤖 جاري معالجة الرسالة عبر محرك SLIE وتمريرها لنماذج الذكاء الاصطناعي...')

	try {
		const pipelineResult = await runSLIEPipeline(testStudentMsg)
		console.log('📊 نتائج التحليل والتصنيف:')
		console.log(`   - القرار النهائـي: ${pipelineResult.decision}`)
		console.log(`   - التصنيـــــــف: ${pipelineResult.analysis.classification}`)
		console.log(`   - المــــــــــادة: ${pipelineResult.analysis.subject}`)
		console.log(`   - التقييم (Score): ${pipelineResult.analysis.leadScore}`)
		console.log(`   - نسبة الثـــــقة: ${pipelineResult.analysis.confidence}`)
		console.log(`   - الســـــــــــبب: ${pipelineResult.analysis.reason}`)

		if (pipelineResult.decision === 'PASS' || pipelineResult.analysis.leadScore >= 40) {
			console.log('RESULT: PASSED ✅\n')
			passedTests++
		} else {
			console.log(`RESULT: FAILED (Decision was ${pipelineResult.decision}) ❌\n`)
		}
	} catch (err) {
		console.error('❌ خطأ أثناء تشغيل محرك SLIE:', err)
		console.log('RESULT: FAILED ❌\n')
	}

	// 3. اختبار قاعدة البيانات والتخزين الداخلي (SQLite / JSON Lead Database)
	totalTests++
	console.log('--- [اختبار 3] قاعدة البيانات والتأكد من منع التكرار ---')
	try {
		const testPhone = '967770000000'
		const testContent = testStudentMsg.text

		const hasBefore = await db.hasLead(testPhone, testContent)
		console.log(`🔍 هل الطلب موجود سابقاً قبل الإضافة؟ ${hasBefore ? 'نعم' : 'لا ✅'}`)

		const savedLead = await db.insertLead({
			studentPhone: testPhone,
			studentName: testStudentMsg.pushName,
			originalGroup: 'مجموعة تجريبية',
			messageContent: testContent,
			classification: 'REQUEST',
			subject: 'برمجة C++',
			score: 85,
			confidence: 0.95
		})

		console.log(`💾 تم حفظ الفرصة بنجاح بالمعرف: ${savedLead.id}`)

		const hasAfter = await db.hasLead(testPhone, testContent)
		console.log(`🔍 هل تـم رصد حماية منع التكرار بعد الإضافة؟ ${hasAfter ? 'نعم (تمت الحماية بنجاح) ✅' : 'لا ❌'}`)

		if (!hasBefore && hasAfter) {
			console.log('RESULT: PASSED ✅\n')
			passedTests++
		} else {
			console.log('RESULT: FAILED ❌\n')
		}
	} catch (err) {
		console.error('❌ خطأ أثناء اختبار قاعدة البيانات:', err)
		console.log('RESULT: FAILED ❌\n')
	}

	console.log('====================================================')
	console.log(`🏁 حصيلة الفحص والشامل: ${passedTests} / ${totalTests} اختبارات نجحت بنجاح!`)
	console.log('====================================================')
}

runComprehensiveVerification().catch(console.error)
