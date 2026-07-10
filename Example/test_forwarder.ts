// تعبير نمطي للبحث عن روابط مجموعات واتساب فقط في النصوص
const groupLinkRegex = /https:\/\/chat\.whatsapp\.com\/(?:invite\/)?[a-zA-Z0-9]+/gi

const testMessages = [
	{
		desc: "رسالة تحتوي على نص ورابط مجموعة عادي",
		text: "السلام عليكم، هذه هي مجموعة العمل الجديدة تفضلوا بالدخول: https://chat.whatsapp.com/AbCdEfGhIjK123 وشكراً لكم."
	},
	{
		desc: "رسالة تحتوي على رابطين لمجموعتين مختلفتين مع نص",
		text: "مجموعة 1: https://chat.whatsapp.com/invite/XYZ12345\nومجموعة 2: https://chat.whatsapp.com/QWERTY99"
	},
	{
		desc: "رسالة تحتوي على رابط عادي لموقع جوجل (يجب ألا يتم التقاطه)",
		text: "يرجى زيارة محرك البحث: https://google.com لمزيد من التفاصيل."
	},
	{
		desc: "رسالة نصية عادية لا تحتوي على أي روابط (يجب ألا يتم التقاطها)",
		text: "السلام عليكم ورحمة الله وبركاته، كيف حالكم اليوم؟"
	}
]

console.log("=== بدء اختبار مطابقة وتصفية الروابط ===")

for (const msg of testMessages) {
	console.log(`\n----------------------------------------`)
	console.log(`📋 الاختبار: ${msg.desc}`)
	console.log(`💬 النص الأصلي:\n"${msg.text}"`)
	
	const matchedLinks = msg.text.match(groupLinkRegex)
	if (matchedLinks && matchedLinks.length > 0) {
		console.log(`✅ النتيجة: تم التقاط الروابط التالية بنجاح (${matchedLinks.length} روابط):`)
		matchedLinks.forEach((link, idx) => {
			console.log(`   [${idx + 1}] -> ${link}`)
		})
	} else {
		console.log(`❌ النتيجة: لم يتم العثور على أي روابط مجموعات واتساب.`)
	}
}
console.log(`\n=== انتهى الاختبار ===`)
