/* ============================================================
 * data.js —— 静态数据层
 * 理由：把「内容」与「逻辑」彻底分离。
 *  1) 食材/菜谱是领域数据，单独放便于后续替换成真实 API 或数据库；
 *  2) 不依赖任何框架和网络，双击 index.html 即可运行，方便检查；
 *  3) 菜品全部是中式家常菜，保证「贴近日常生活」而非演示玩具。
 * ============================================================ */
(function (w) {
  'use strict';

  // 分类色板：用于列表色标，避免依赖图片资源
  var CATS = {
    '蔬菜':   { color: '#1D9E75', bg: '#E1F5EE' },
    '肉蛋':   { color: '#D85A30', bg: '#FAECE7' },
    '水产':   { color: '#378ADD', bg: '#E6F1FB' },
    '主食':   { color: '#BA7517', bg: '#FAEEDA' },
    '豆制品': { color: '#7F77DD', bg: '#EEEDFE' },
    '调味':   { color: '#888780', bg: '#F1EFE8' },
    '乳品水果': { color: '#D4537E', bg: '#FBEAF0' }
  };

  /* id / 名称 / 分类 / 默认保质期(天) / 单位 / 参考单价(元) / 单位克数(unitG) / 每100g营养
   * price 用于「少浪费 = 省了多少钱」的估算，是产品核心叙事的量化依据。
   * unitG = 菜谱里该食材以「自然单位」(个/根/颗/把/盒/条/包) 描述时，每单位对应的克数；
   *   菜谱里若直接写 "150g" 则按克计，不经 unitG。片/瓣/勺/碗 由引擎统一换算，无需在此定义。
   * nutrition = 每 100g 的 {kcal 热量, P 蛋白质, F 脂肪, C 碳水, fiber 膳食纤维}，
   *   取自常见食物成分表的近似值，仅用于演示级的营养估算（已在界面标注「参考值」）。 */
  var FOODS = [
    { id: 'tomato',   name: '西红柿',   cat: '蔬菜',   shelf: 7,   unit: '个',  price: 2.5,  unitG: 150, nutrition: { kcal: 18,  P: 0.9, F: 0.2, C: 3.9, fiber: 1.2 } },
    { id: 'egg',      name: '鸡蛋',     cat: '肉蛋',   shelf: 25,  unit: '个',  price: 1.2,  unitG: 50,  nutrition: { kcal: 144, P: 13.3, F: 8.8, C: 2.8, fiber: 0 } },
    { id: 'pepper',   name: '青椒',     cat: '蔬菜',   shelf: 8,   unit: '个',  price: 1.8,  unitG: 120, nutrition: { kcal: 22,  P: 1.0, F: 0.2, C: 4.6, fiber: 1.4 } },
    { id: 'potato',   name: '土豆',     cat: '蔬菜',   shelf: 30,  unit: '个',  price: 2.0,  unitG: 200, nutrition: { kcal: 77,  P: 2.0, F: 0.1, C: 17, fiber: 1.1 } },
    { id: 'onion',    name: '洋葱',     cat: '蔬菜',   shelf: 30,  unit: '个',  price: 2.2,  unitG: 150, nutrition: { kcal: 40,  P: 1.1, F: 0.1, C: 9.3, fiber: 1.7 } },
    { id: 'pork',     name: '猪肉',     cat: '肉蛋',   shelf: 3,   unit: 'g',   price: 0.04, unitG: 1,   nutrition: { kcal: 143, P: 20.3, F: 6.2, C: 1.5, fiber: 0 } },
    { id: 'tofu',     name: '豆腐',     cat: '豆制品', shelf: 4,   unit: '盒',  price: 4.0,  unitG: 400, nutrition: { kcal: 81,  P: 8.1, F: 3.7, C: 4.2, fiber: 0.4 } },
    { id: 'scallion', name: '葱',       cat: '调味',   shelf: 10,  unit: '把',  price: 2.0,  unitG: 80,  nutrition: { kcal: 30,  P: 1.7, F: 0.3, C: 6.5, fiber: 2.6 } },
    { id: 'ginger',   name: '姜',       cat: '调味',   shelf: 30,  unit: '块',  price: 1.5,  unitG: 30,  nutrition: { kcal: 41,  P: 1.3, F: 0.7, C: 9, fiber: 2.9 } },
    { id: 'garlic',   name: '蒜',       cat: '调味',   shelf: 45,  unit: '头',  price: 1.5,  unitG: 40,  nutrition: { kcal: 127, P: 4.5, F: 0.2, C: 27, fiber: 2.4 } },
    { id: 'soy',      name: '生抽',     cat: '调味',   shelf: 365, unit: '瓶',  price: 12.0, unitG: 15,  nutrition: { kcal: 53,  P: 4.8, F: 0.1, C: 8, fiber: 0.8 } },
    { id: 'vinegar',  name: '醋',       cat: '调味',   shelf: 365, unit: '瓶',  price: 8.0,  unitG: 15,  nutrition: { kcal: 31,  P: 0.4, F: 0, C: 5, fiber: 0 } },
    { id: 'oil',      name: '食用油',   cat: '调味',   shelf: 365, unit: '瓶',  price: 30.0, unitG: 15,  nutrition: { kcal: 899, P: 0, F: 99.9, C: 0, fiber: 0 } },
    { id: 'salt',     name: '盐',       cat: '调味',   shelf: 720, unit: '袋',  price: 3.0,  unitG: 15,  nutrition: { kcal: 0, P: 0, F: 0, C: 0, fiber: 0 } },
    { id: 'sugar',    name: '糖',       cat: '调味',   shelf: 720, unit: '袋',  price: 6.0,  unitG: 15,  nutrition: { kcal: 400, P: 0, F: 0, C: 100, fiber: 0 } },
    { id: 'chili',    name: '干辣椒',   cat: '调味',   shelf: 365, unit: '袋',  price: 5.0,  unitG: 15,  nutrition: { kcal: 212, P: 12, F: 6, C: 38, fiber: 30 } },
    { id: 'rice',     name: '大米',     cat: '主食',   shelf: 300, unit: '袋',  price: 45.0, unitG: 250, nutrition: { kcal: 116, P: 2.6, F: 0.3, C: 25.9, fiber: 0.3 } },
    { id: 'noodle',   name: '面条',     cat: '主食',   shelf: 180, unit: '把',  price: 6.0,  unitG: 100, nutrition: { kcal: 350, P: 12, F: 1.5, C: 70, fiber: 2.5 } },
    { id: 'cucumber', name: '黄瓜',     cat: '蔬菜',   shelf: 8,   unit: '根',  price: 2.5,  unitG: 200, nutrition: { kcal: 15,  P: 0.8, F: 0.1, C: 3.6, fiber: 0.5 } },
    { id: 'carrot',   name: '胡萝卜',   cat: '蔬菜',   shelf: 20,  unit: '根',  price: 1.8,  unitG: 150, nutrition: { kcal: 39,  P: 1.0, F: 0.2, C: 8.8, fiber: 2.8 } },
    { id: 'eggplant', name: '茄子',     cat: '蔬菜',   shelf: 7,   unit: '个',  price: 3.0,  unitG: 250, nutrition: { kcal: 23,  P: 1.0, F: 0.2, C: 5.4, fiber: 1.3 } },
    { id: 'broccoli', name: '西兰花',   cat: '蔬菜',   shelf: 6,   unit: '颗',  price: 5.0,  unitG: 300, nutrition: { kcal: 34,  P: 4.1, F: 0.6, C: 4.3, fiber: 2.6 } },
    { id: 'greens',   name: '青菜',     cat: '蔬菜',   shelf: 4,   unit: '把',  price: 3.5,  unitG: 250, nutrition: { kcal: 15,  P: 1.5, F: 0.1, C: 2.5, fiber: 1.1 } },
    { id: 'mushroom', name: '香菇',     cat: '蔬菜',   shelf: 7,   unit: '盒',  price: 6.0,  unitG: 200, nutrition: { kcal: 26,  P: 2.2, F: 0.3, C: 5.2, fiber: 3.3 } },
    { id: 'chicken',  name: '鸡翅',     cat: '肉蛋',   shelf: 3,   unit: 'g',   price: 0.045, unitG: 1,  nutrition: { kcal: 190, P: 13, F: 12, C: 0, fiber: 0 } },
    { id: 'fish',     name: '鱼',       cat: '水产',   shelf: 2,   unit: '条',  price: 22.0, unitG: 500, nutrition: { kcal: 110, P: 18, F: 3, C: 0, fiber: 0 } },
    { id: 'shrimp',   name: '虾',       cat: '水产',   shelf: 2,   unit: 'g',   price: 0.09, unitG: 1,   nutrition: { kcal: 93, P: 18.6, F: 1.7, C: 2.8, fiber: 0 } },
    { id: 'seaweed',  name: '紫菜',     cat: '水产',   shelf: 365, unit: '包',  price: 8.0,  unitG: 5,   nutrition: { kcal: 250, P: 26, F: 1.8, C: 40, fiber: 30 } },
    { id: 'milk',     name: '牛奶',     cat: '乳品水果', shelf: 15, unit: '盒', price: 4.0,  unitG: 250, nutrition: { kcal: 54, P: 3.0, F: 3.2, C: 3.4, fiber: 0 } },
    { id: 'banana',   name: '香蕉',     cat: '乳品水果', shelf: 6,  unit: '根', price: 1.5,  unitG: 120, nutrition: { kcal: 93, P: 1.4, F: 0.2, C: 22, fiber: 2.6 } },
    { id: 'apple',    name: '苹果',     cat: '乳品水果', shelf: 30, unit: '个', price: 4.0,  unitG: 200, nutrition: { kcal: 54, P: 0.2, F: 0.2, C: 14, fiber: 2.4 } }
  ];

  /* 菜谱库：ingredients 中 optional=true 的是「可省略辅料」，不计入必需覆盖率，
   * 这样推荐结果不会因为缺一根葱而被判为做不了 —— 更贴近真实厨房逻辑。 */
  var RECIPES = [
    { id:'r01', name:'西红柿炒鸡蛋', cat:'家常菜', time:10, diff:'简单', servings:2, flavor:'清淡',
      kcal:210, ingredients:[{id:'tomato',qty:'2 个'},{id:'egg',qty:'3 个'},{id:'scallion',qty:'少许',optional:true},{id:'sugar',qty:'少许',optional:true}], tags:['快手','下饭','低卡','早餐','清库存'],
      steps:['西红柿切块，鸡蛋打散加少许盐。','热油炒蛋至凝固盛出。','下西红柿炒出汁，加少许糖提鲜。','回锅炒蛋，翻匀撒葱花出锅。'] },
    { id:'r02', name:'青椒土豆丝', cat:'家常菜', time:15, diff:'简单', servings:2, flavor:'清淡', tags:['快手','下饭','低卡','素'],
      kcal:160, ingredients:[{id:'potato',qty:'2 个'},{id:'pepper',qty:'1 个'},{id:'garlic',qty:'2 瓣'},{id:'vinegar',qty:'少许',optional:true}],
      steps:['土豆切细丝，清水泡去淀粉。','青椒切丝，蒜切末。','热油爆蒜，下土豆丝大火快炒。','加青椒、盐、少许醋，断生出锅。'] },
    { id:'r03', name:'青椒肉丝', cat:'家常菜', time:20, diff:'简单', servings:2, flavor:'咸鲜', tags:['下饭','高蛋白'],
      kcal:320, ingredients:[{id:'pork',qty:'150g'},{id:'pepper',qty:'2 个'},{id:'ginger',qty:'少许'},{id:'soy',qty:'1 勺'}],
      steps:['猪肉切丝，用生抽、姜丝腌 10 分钟。','青椒切丝备用。','热锅滑散肉丝至变色盛出。','下青椒炒软，回锅肉丝，调味翻匀。'] },
    { id:'r04', name:'家常豆腐', cat:'家常菜', time:20, diff:'简单', servings:2, flavor:'咸鲜', tags:['下饭','素','高蛋白'],
      kcal:260, ingredients:[{id:'tofu',qty:'1 盒'},{id:'pepper',qty:'1 个'},{id:'scallion',qty:'少许'},{id:'soy',qty:'1 勺'}],
      steps:['豆腐切三角块，煎至两面金黄。','青椒切块，葱切段。','爆香葱白，下豆腐与青椒。','加生抽、少量水焖 3 分钟收汁。'] },
    { id:'r05', name:'番茄豆腐汤', cat:'汤羹', time:15, diff:'简单', servings:2, flavor:'清淡', tags:['快手','低卡','素','清库存'],
      kcal:120, ingredients:[{id:'tomato',qty:'2 个'},{id:'tofu',qty:'1 盒'},{id:'scallion',qty:'少许',optional:true}],
      steps:['西红柿切块炒出红油。','加两碗水烧开。','下豆腐块煮 5 分钟。','调盐，撒葱花出锅。'] },
    { id:'r06', name:'土豆炖肉', cat:'家常菜', time:40, diff:'中等', servings:3, flavor:'咸鲜', tags:['下饭','高蛋白','炖菜'],
      kcal:430, ingredients:[{id:'potato',qty:'2 个'},{id:'pork',qty:'250g'},{id:'ginger',qty:'3 片'},{id:'soy',qty:'2 勺'}],
      steps:['猪肉切块焯水，土豆切滚刀块。','姜片爆香，下肉块翻炒上色。','加生抽、热水没过食材，小火炖 25 分钟。','下土豆再炖 12 分钟，收汁调味。'] },
    { id:'r07', name:'洋葱炒蛋', cat:'快手菜', time:12, diff:'简单', servings:2, flavor:'咸鲜',
      kcal:230, ingredients:[{id:'onion',qty:'1 个'},{id:'egg',qty:'3 个'},{id:'soy',qty:'少许',optional:true}], tags:['快手','下饭','早餐'],
      steps:['洋葱切丝，鸡蛋打散。','先炒蛋盛出。','下洋葱炒至微黄透明。','回锅炒蛋，加盐调味。'] },
    { id:'r08', name:'蒜蓉黄瓜', cat:'快手菜', time:8, diff:'简单', servings:2, flavor:'清淡', tags:['快手','低卡','素','凉菜'],
      kcal:60, ingredients:[{id:'cucumber',qty:'1 根'},{id:'garlic',qty:'3 瓣'},{id:'vinegar',qty:'少许',optional:true}],
      steps:['黄瓜拍裂切段，加少许盐腌 5 分钟。','蒜切末，加醋、生抽调汁。','倒掉腌出的水。','淋汁拌匀，冷藏 5 分钟更爽口。'] },
    { id:'r09', name:'胡萝卜炒鸡蛋', cat:'快手菜', time:12, diff:'简单', servings:2, flavor:'清淡',
      kcal:220, ingredients:[{id:'carrot',qty:'1 根'},{id:'egg',qty:'3 个'},{id:'scallion',qty:'少许',optional:true}], tags:['快手','低卡','早餐'],
      steps:['胡萝卜切细丝，鸡蛋打散。','先炒蛋盛出。','下胡萝卜丝炒软。','回锅炒蛋，加盐调味。'] },
    { id:'r10', name:'酸辣土豆丝', cat:'家常菜', time:15, diff:'简单', servings:2, flavor:'酸辣', tags:['快手','下饭','素'],
      kcal:180, ingredients:[{id:'potato',qty:'2 个'},{id:'chili',qty:'少许'},{id:'garlic',qty:'2 瓣'},{id:'vinegar',qty:'1 勺'}],
      steps:['土豆切丝泡水去淀粉。','热油爆香干辣椒与蒜末。','下土豆丝大火快炒 2 分钟。','沿锅边淋醋，加盐出锅。'] },
    { id:'r11', name:'番茄鸡蛋面', cat:'主食', time:15, diff:'简单', servings:1, flavor:'清淡',
      kcal:420, ingredients:[{id:'tomato',qty:'1 个'},{id:'egg',qty:'2 个'},{id:'noodle',qty:'1 把'},{id:'scallion',qty:'少许',optional:true}], tags:['快手','一人食','早餐','清库存'],
      steps:['西红柿炒出汁，加水烧开。','下面条煮至八成熟。','淋入蛋液形成蛋花。','调盐，撒葱花出锅。'] },
    { id:'r12', name:'蛋炒饭', cat:'主食', time:12, diff:'简单', servings:1, flavor:'咸鲜',
      kcal:480, ingredients:[{id:'rice',qty:'1 碗'},{id:'egg',qty:'2 个'},{id:'scallion',qty:'少许'},{id:'soy',qty:'1 勺'}], tags:['快手','一人食','清库存','早餐'],
      steps:['隔夜米饭抓散，鸡蛋打散。','炒蛋盛出。','下米饭中火炒散炒香。','回锅蛋，加生抽、葱花翻匀。'] },
    { id:'r13', name:'青椒炒蛋', cat:'快手菜', time:10, diff:'简单', servings:2, flavor:'咸鲜', tags:['快手','下饭'],
      kcal:215, ingredients:[{id:'pepper',qty:'2 个'},{id:'egg',qty:'3 个'},{id:'soy',qty:'少许',optional:true}],
      steps:['青椒切小块，鸡蛋打散。','炒蛋盛出。','青椒炒至虎皮状。','回锅炒蛋，调味出锅。'] },
    { id:'r14', name:'肉末豆腐', cat:'家常菜', time:20, diff:'简单', servings:2, flavor:'咸鲜', tags:['下饭','高蛋白'],
      kcal:340, ingredients:[{id:'pork',qty:'100g'},{id:'tofu',qty:'1 盒'},{id:'scallion',qty:'少许'},{id:'soy',qty:'1 勺'}],
      steps:['猪肉剁末，豆腐切块。','肉末炒至出油，加生抽。','下豆腐轻推，加少量水焖 5 分钟。','收汁撒葱花。'] },
    { id:'r15', name:'黄瓜炒鸡蛋', cat:'快手菜', time:12, diff:'简单', servings:2, flavor:'清淡',
      kcal:200, ingredients:[{id:'cucumber',qty:'1 根'},{id:'egg',qty:'3 个'},{id:'garlic',qty:'2 瓣',optional:true}], tags:['快手','低卡','早餐'],
      steps:['黄瓜切片，鸡蛋打散。','先炒蛋盛出。','下黄瓜片大火快炒。','回锅炒蛋，加盐调味。'] },
    { id:'r16', name:'洋葱炒肉', cat:'家常菜', time:20, diff:'简单', servings:2, flavor:'咸鲜', tags:['下饭','高蛋白'],
      kcal:330, ingredients:[{id:'onion',qty:'1 个'},{id:'pork',qty:'150g'},{id:'soy',qty:'1 勺'},{id:'ginger',qty:'少许',optional:true}],
      steps:['肉切片腌 10 分钟，洋葱切丝。','滑炒肉片至变色盛出。','下洋葱炒软出甜味。','回锅肉片，加生抽翻匀。'] },
    { id:'r17', name:'地三鲜', cat:'家常菜', time:25, diff:'中等', servings:3, flavor:'咸鲜', tags:['下饭','素','清库存'],
      kcal:360, ingredients:[{id:'potato',qty:'1 个'},{id:'eggplant',qty:'1 个'},{id:'pepper',qty:'1 个'},{id:'garlic',qty:'3 瓣'}],
      steps:['土豆、茄子切滚刀块，青椒切块。','分别把土豆、茄子煎至表面金黄。','爆香蒜末，下全部食材。','加生抽、少许水焖 3 分钟收汁。'] },
    { id:'r18', name:'番茄土豆汤', cat:'汤羹', time:20, diff:'简单', servings:2, flavor:'清淡', tags:['低卡','素','清库存'],
      kcal:140, ingredients:[{id:'tomato',qty:'2 个'},{id:'potato',qty:'1 个'},{id:'scallion',qty:'少许',optional:true}],
      steps:['西红柿炒出汁。','土豆切薄片，加水同煮 12 分钟。','煮至土豆软糯。','调盐撒葱花。'] },
    { id:'r19', name:'胡萝卜炖肉', cat:'家常菜', time:40, diff:'中等', servings:3, flavor:'咸鲜', tags:['炖菜','高蛋白'],
      kcal:410, ingredients:[{id:'carrot',qty:'2 根'},{id:'pork',qty:'250g'},{id:'ginger',qty:'3 片'},{id:'soy',qty:'2 勺'}],
      steps:['肉块焯水，胡萝卜切滚刀块。','姜片爆香，下肉块翻炒。','加热水与生抽炖 25 分钟。','下胡萝卜再炖 12 分钟收汁。'] },
    { id:'r20', name:'蒜香西兰花', cat:'快手菜', time:12, diff:'简单', servings:2, flavor:'清淡', tags:['快手','低卡','素','清库存'],
      kcal:110, ingredients:[{id:'broccoli',qty:'1 颗'},{id:'garlic',qty:'3 瓣'},{id:'soy',qty:'少许',optional:true}],
      steps:['西兰花掰小朵，焯水 1 分钟。','蒜切末爆香。','下西兰花大火翻炒。','调盐或少许生抽出锅。'] },
    { id:'r21', name:'香菇青菜', cat:'快手菜', time:12, diff:'简单', servings:2, flavor:'清淡', tags:['快手','低卡','素','清库存'],
      kcal:100, ingredients:[{id:'mushroom',qty:'1 盒'},{id:'greens',qty:'1 把'},{id:'garlic',qty:'2 瓣'}],
      steps:['香菇切片，青菜洗净切段。','蒜末爆香，下香菇炒软。','下青菜大火快炒。','调盐出锅。'] },
    { id:'r22', name:'红烧鸡翅', cat:'家常菜', time:30, diff:'中等', servings:2, flavor:'咸鲜', tags:['下饭','高蛋白'],
      kcal:390, ingredients:[{id:'chicken',qty:'300g'},{id:'ginger',qty:'3 片'},{id:'soy',qty:'2 勺'},{id:'sugar',qty:'1 勺'}],
      steps:['鸡翅划两刀，冷水下锅焯水。','姜片爆香，鸡翅煎至两面金黄。','加生抽、糖、热水没过食材。','中小火焖 15 分钟，大火收汁。'] },
    { id:'r23', name:'清蒸鱼', cat:'家常菜', time:25, diff:'中等', servings:3, flavor:'清淡', tags:['高蛋白','低卡'],
      kcal:240, ingredients:[{id:'fish',qty:'1 条'},{id:'ginger',qty:'4 片'},{id:'scallion',qty:'1 把'},{id:'soy',qty:'2 勺'}],
      steps:['鱼处理干净，两面划刀，铺姜片。','水开后上锅蒸 8-10 分钟。','倒掉盘中腥水，铺葱丝。','淋热油与生抽即可。'] },
    { id:'r24', name:'紫菜蛋花汤', cat:'汤羹', time:8, diff:'简单', servings:2, flavor:'清淡',
      kcal:90, ingredients:[{id:'seaweed',qty:'1 包'},{id:'egg',qty:'2 个'},{id:'scallion',qty:'少许',optional:true}], tags:['快手','低卡','早餐','清库存'],
      steps:['水烧开，下紫菜。','蛋液缓缓淋入形成蛋花。','调盐，关火。','撒葱花、滴几滴香油。'] },
    { id:'r25', name:'麻婆豆腐', cat:'家常菜', time:20, diff:'中等', servings:2, flavor:'麻辣', tags:['下饭','高蛋白'],
      kcal:330, ingredients:[{id:'tofu',qty:'1 盒'},{id:'pork',qty:'80g'},{id:'chili',qty:'少许'},{id:'soy',qty:'1 勺'},{id:'scallion',qty:'少许',optional:true}],
      steps:['豆腐切块，淡盐水焯一下。','肉末与干辣椒炒香。','加生抽、半碗水，下豆腐焖 5 分钟。','水淀粉勾芡，撒葱花。'] },
    { id:'r26', name:'凉拌番茄', cat:'快手菜', time:5, diff:'简单', servings:2, flavor:'酸甜', tags:['快手','低卡','素','凉菜'],
      kcal:70, ingredients:[{id:'tomato',qty:'2 个'},{id:'sugar',qty:'1 勺'}],
      steps:['西红柿洗净切片。','按一层番茄一层糖码盘。','冷藏 10 分钟。','出盘即可食用。'] },
    /* 以下 4 道用于补齐「孤儿食材」：虾、牛奶、香蕉、苹果原先没有任何菜谱使用，
     * 导致它们即使临期也永远不可能出现在推荐里。补菜谱后覆盖闭环才完整。 */
    { id:'r27', name:'虾仁炒蛋', cat:'快手菜', time:12, diff:'简单', servings:2, flavor:'咸鲜', tags:['快手','高蛋白','清库存'],
      kcal:260, ingredients:[{id:'shrimp',qty:'150g'},{id:'egg',qty:'3 个'},{id:'scallion',qty:'少许',optional:true},{id:'salt',qty:'少许',optional:true}],
      steps:['虾去壳去虾线，鸡蛋打散加少许盐。','虾仁快炒至变色盛出。','炒蛋至半凝固时回锅虾仁。','翻匀撒葱花出锅。'] },
    { id:'r28', name:'蒜蓉虾', cat:'家常菜', time:15, diff:'简单', servings:2, flavor:'咸鲜', tags:['快手','高蛋白'],
      kcal:190, ingredients:[{id:'shrimp',qty:'250g'},{id:'garlic',qty:'4 瓣'},{id:'soy',qty:'1 勺',optional:true},{id:'scallion',qty:'少许',optional:true}],
      steps:['虾开背去虾线，蒜切末。','热油爆香一半蒜末，下虾煎至两面变红。','加生抽与另一半蒜末翻匀。','盖盖焖 2 分钟，撒葱花出锅。'] },
    { id:'r29', name:'香蕉牛奶饮', cat:'快手菜', time:5, diff:'简单', servings:2, flavor:'酸甜', tags:['快手','免开火','清库存','早餐'],
      kcal:180, ingredients:[{id:'banana',qty:'2 根'},{id:'milk',qty:'1 盒'}],
      steps:['香蕉去皮切段。','与牛奶一起放入搅拌机。','打 30 秒至顺滑。','倒出即可，无需加糖。'] },
    { id:'r30', name:'苹果糖水', cat:'汤羹', time:15, diff:'简单', servings:2, flavor:'酸甜', tags:['快手','素','清库存'],
      kcal:130, ingredients:[{id:'apple',qty:'2 个'},{id:'sugar',qty:'1 勺'}],
      steps:['苹果去皮去核切块。','加两碗水与冰糖/白糖煮开。','转小火煮 10 分钟至苹果透明。','温热或冷藏后都可以吃。'] }
  ];

  /* 平台中立：购物清单可分发到多家，不锁定任何一家电商。
   * 这是竞品分析报告里确认的核心差异化，必须在产品里落地。 */
  var PLATFORMS = ['叮咚买菜', '盒马', '美团买菜', '京东到家', '本地菜市场（自备清单）'];

  /* 首次打开预置的示例库存：含 3 样临期食材，保证打开即能看到完整效果。
   * leftDays 是「剩余天数」，运行时会换算成具体到期日存储。 */
  var SEED = [
    { foodId:'tomato',   qty:3,   leftDays:1 },
    { foodId:'egg',      qty:8,   leftDays:12 },
    { foodId:'pepper',   qty:2,   leftDays:2 },
    { foodId:'pork',     qty:300, leftDays:1 },
    { foodId:'tofu',     qty:1,   leftDays:2 },
    { foodId:'potato',   qty:2,   leftDays:20 },
    { foodId:'onion',    qty:1,   leftDays:15 },
    { foodId:'cucumber', qty:1,   leftDays:4 },
    { foodId:'carrot',   qty:1,   leftDays:10 },
    { foodId:'scallion', qty:1,   leftDays:3 },
    { foodId:'ginger',   qty:1,   leftDays:20 },
    { foodId:'garlic',   qty:1,   leftDays:30 },
    { foodId:'soy',      qty:1,   leftDays:180 },
    { foodId:'rice',     qty:1,   leftDays:200 },
    /* 下面 4 样是「回归验证样本」，覆盖此前会静默消失的几类临期食材：
     * shrimp 2 天=紧急且原先无菜谱；milk/banana 5~6 天=留意级且原先零加权；
     * greens -1 天=已过期，用于演示「建议丢弃」而非照常推荐。 */
    { foodId:'shrimp',   qty:200, leftDays:2 },
    { foodId:'milk',     qty:2,   leftDays:5 },
    { foodId:'banana',   qty:3,   leftDays:6 },
    { foodId:'greens',   qty:1,   leftDays:-1 }
  ];

  w.XZ_DATA = { CATS: CATS, FOODS: FOODS, RECIPES: RECIPES, PLATFORMS: PLATFORMS, SEED: SEED };
})(window);
