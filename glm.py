from openai import OpenAI
from dotenv import load_dotenv
import os

load_dotenv()
client = OpenAI(
    api_key=os.getenv("ZHIPU_API_KEY"),
    base_url="https://open.bigmodel.cn/api/paas/v4/"
)

resp = client.chat.completions.create(
    model="glm-4.7-flash",
    messages=[{"role":"user","content":"我抽到了塔罗的星币3，帮我解读今日运势"}]
)
print(resp.choices[0].message.content)

