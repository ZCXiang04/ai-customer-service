import csv
import os
import random

random.seed(20260918)

# 常见中文姓氏
surnames = list("王李张刘陈杨黄赵周吴徐孙朱马胡郭林何高梁郑罗宋谢唐韩冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段漕钱汤尹黎易常武乔贺")

# 常用名用字
given_chars = list("伟芳娜秀英敏静丽强磊洋勇艳杰娟涛明超秀霞平刚桂英文辉力博鑫宇浩晨睿欣怡轩子涵梓萱浩然嘉怡俊熙梓睿沐辰一诺语桐思远嘉豪雨萱晓彤宇航梦琪志强建国春梅")

cities = [
    "北京", "上海", "广州", "深圳", "杭州", "成都", "武汉", "南京", "西安", "重庆",
    "苏州", "天津", "长沙", "郑州", "青岛", "宁波", "东莞", "无锡", "佛山", "合肥",
    "昆明", "大连", "厦门", "哈尔滨", "济南", "福州", "温州", "沈阳", "石家庄", "南宁",
    "常州", "泉州", "南昌", "贵阳", "太原", "烟台", "嘉兴", "南通", "金华", "珠海",
    "惠州", "徐州", "海口", "乌鲁木齐", "兰州", "潍坊", "保定", "镇江", "扬州", "桂林",
]

# 常见快递公司单号前缀
carrier_prefixes = {
    "SF": "SF",      # 顺丰
    "YT": "YT",      # 圆通
    "ZTO": "73",     # 中通
    "YD": "YD",      # 韵达
    "JD": "JD",      # 京东
    "EMS": "EA",     # EMS
}

items = [
    "无线蓝牙耳机", "纯棉短袖T恤", "不锈钢保温杯", "机械键盘", "运动跑鞋",
    "婴儿纸尿裤", "保湿面霜", "智能手环", "空气炸锅", "电动牙刷",
    "羽绒服", "坚果零食大礼包", "笔记本平板", "台灯护眼灯", "瑜伽垫",
    "猫粮10kg", "电动剃须刀", "颈椎按摩仪", "儿童积木玩具", "保温饭盒",
    "真无线降噪耳机", "家用扫地机器人", "电热水壶", "护肤精华液", "速干运动裤",
    "书籍《三体》全集", "数码相机", "游戏手柄", "雨伞折叠伞", "厨房刀具套装",
    "蚕丝被", "行李箱24寸", "加湿器", "蓝牙音箱", "手机壳保护套",
    "茶叶礼盒", "咖啡豆1kg", "宠物饮水机", "电吹风", "按摩靠垫",
]

def gen_name():
    surname = random.choice(surnames)
    length = random.choice([1, 2])
    given = "".join(random.choice(given_chars) for _ in range(length))
    return surname + given

def gen_phone():
    prefixes = ["138", "139", "136", "137", "135", "150", "151", "152",
                "158", "159", "182", "183", "184", "187", "188", "198",
                "199", "130", "131", "132", "156", "186", "176", "177"]
    return random.choice(prefixes) + "".join(str(random.randint(0, 9)) for _ in range(8))

def gen_tracking_no():
    carrier = random.choice(list(carrier_prefixes.keys()))
    prefix = carrier_prefixes[carrier]
    body = "".join(str(random.randint(0, 9)) for _ in range(12))
    return prefix + body

rows = []
for i in range(1, 101):
    rows.append([
        i,
        gen_name(),
        gen_phone(),
        random.choice(cities),
        gen_tracking_no(),
        random.choice(items),
    ])

header = ["顺序id", "姓名", "用户手机号", "居住城市", "快递单号", "购买物品"]

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "快递信息.csv")
with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(header)
    writer.writerows(rows)

print(f"已生成 {len(rows)} 条数据，保存至: {out_path}")
print("前5条示例:")
for r in rows[:5]:
    print(r)
