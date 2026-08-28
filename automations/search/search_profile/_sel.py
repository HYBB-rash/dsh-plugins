
import sys, time, json, re, os
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

opts = Options()
opts.binary_location = sys.argv[1]
opts.add_argument("--headless")
opts.set_preference("general.useragent.override", sys.argv[2])
opts.set_preference("dom.webdriver.enabled", False)
opts.set_preference("useAutomationExtension", False)
if sys.argv[3] and os.path.isdir(sys.argv[3]):
    opts.profile = sys.argv[3]

svc = Service(sys.argv[4], log_output="/dev/null")
drv = webdriver.Firefox(options=opts, service=svc)
try:
    drv.get(sys.argv[5])
    time.sleep(float(sys.argv[6]))
    print("__CURL__=" + drv.current_url)
    print(drv.page_source)
finally:
    drv.quit()
