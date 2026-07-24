import { isSpamLinkText } from './bot/services/ruleEngine';
import { db } from './bot/database/database';

async function testLinkFilter() {
	console.log('🧪 بدء اختبار فلاتر الروابط وكشف الإعلانات...\n');

	// 1. اختبار كشف الإعلانات والسبام (isSpamLinkText)
	const testCases = [
		{
			name: 'إعلان خدمات أكاديمية صريح',
			text: '📚 مكتب التميز للخدمات الطلابية 📚\n🔹 حل واجبات كويزات اختبارات\n🔹 مشاريع تخرج وأبحاث بأسعار مناسبة\n📞 للتواصل خاص أو واتساب +966500000000\nhttps://chat.whatsapp.com/L12345',
			expected: true
		},
		{
			name: 'إعلان سبام ترفيهي/دردشة',
			text: 'قروب وناسة وفلة وضحك وسهرات 🥳🔥\nنشر روابط وتبادل قروبات يومياً\nhttps://chat.whatsapp.com/G54321',
			expected: true
		},
		{
			name: 'رابط مباشر للتواصل (wa.me)',
			text: 'مين يقدر يحل لي الواجب؟ تواصل معي مباشرة هنا wa.me/966512345678',
			expected: true
		},
		{
			name: 'رابط مجموعة دراسي نظيف',
			text: 'يا شباب هذا رابط مجموعة مادة رياضيات 101 للمناقشة وحل المسائل مع بعض\nhttps://chat.whatsapp.com/M98765',
			expected: false
		}
	];

	let passedTests = 0;

	for (const tc of testCases) {
		const result = isSpamLinkText(tc.text);
		const status = result === tc.expected ? '✅ نجح' : '❌ فشل';
		if (result === tc.expected) passedTests++;
		console.log(`[${status}] الاختبار: "${tc.name}"`);
		console.log(`- النص: "${tc.text.slice(0, 100).replace(/\n/g, ' ')}..."`);
		console.log(`- النتيجة الفعلية: ${result} | المتوقعة: ${tc.expected}\n`);
	}

	// 2. اختبار منع التكرار العالمي (hasLinkBeenSent)
	console.log('🔄 اختبار منع تكرار الرابط عينه (تجنب الإرسال المزدوج):');
	
	const testLink = 'https://chat.whatsapp.com/DuplicateLink123';
	
	// ندخل الرابط بشكل مؤقت كفرصة في قاعدة البيانات
	await db.insertLead({
		studentPhone: '966599999999',
		studentName: 'طالب تجريبي',
		originalGroup: 'روابط مجموعات',
		messageContent: testLink,
		classification: 'DISCUSSION',
		subject: 'رابط مجموعة',
		score: 50,
		confidence: 0.8
	});

	const isDuplicate = await db.hasLinkBeenSent(testLink);
	if (isDuplicate) {
		console.log('✅ نجح: تم كشف الرابط المكرر بنجاح وحظره من الإرسال مجدداً.');
		passedTests++;
	} else {
		console.log('❌ فشل: لم يتم كشف الرابط المكرر.');
	}

	console.log(`\n📊 محصلة الاختبارات: نجح ${passedTests} من أصل 5 اختبارات.`);
}

testLinkFilter();
