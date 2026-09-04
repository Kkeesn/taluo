from openai import OpenAI
from dotenv import load_dotenv
import os

load_dotenv()
client = OpenAI(
    api_key=os.getenv("ZHIPU_API_KEY"),
    base_url="https://open.bigmodel.cn/api/paas/v4/"
)

sys_prompt = "你是塔罗解读助手，基于抽到的卡牌做解读。"
user_msg = "星币3，正位，今日运势"

resp = client.chat.completions.create(
    model="glm-z1-flash",
    messages=[
        {"role":"system", "content":sys_prompt},
        {"role":"user", "content":user_msg}
    ],
    temperature=0.8
)
print("==== GLM-Z1-Flash ====")
print(resp.choices[0].message.content)