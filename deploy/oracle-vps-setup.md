# Run the FPL Telegram bot on Oracle Cloud Always Free

This guide assumes an Ubuntu VM and keeps the bot credentials on the VM, not in GitHub.

## 1. Create the VM

1. Sign up at [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/). Choose the home region carefully; Oracle says Always Free compute can only be provisioned in that home region. Signup can require a phone number and payment card for verification. Oracle states the card is not charged unless the account is upgraded.
2. In the OCI console, create a Compute instance in the home region.
3. Select an Ubuntu image and an Ampere A1 Flex shape marked Always Free eligible. A small VM such as 1 OCPU and 6 GB RAM is enough for this bot and stays within the current post-trial A1 allowance Oracle documents (2 OCPUs and 12 GB total). Availability varies by region; do not select a paid shape if the free-eligible option is unavailable.
4. Use a public subnet/public IP and add an ingress rule for SSH (TCP port 22) restricted to your own IP address. The bot uses outbound HTTPS polling, so no inbound Telegram port is needed.
5. Add an SSH public key to the instance and save the private key securely on your Mac.

## 2. Connect and install the bot

SSH to the VM using the Ubuntu username and its public IP. Then run:

```sh
sudo apt update
sudo apt install -y git python3-venv
cd /home/ubuntu
git clone https://github.com/jmspro123/fpl_updates.git
cd /home/ubuntu/fpl_updates
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

If the repository is private, authenticate with GitHub using a secure method; never put a personal access token in the repository or in this guide.

## 3. Add credentials privately on the VM

Open a root-owned environment file:

```sh
sudo nano /etc/fpl-bot.env
```

Enter these lines with the real values (no quotes are needed):

```text
TG_TOKEN=your_telegram_bot_token
FPL_LEAGUE_ID=your_main_league_id
TG_CHAT_ID=your_main_group_chat_id
FPL_LEAGUE_ID_2=your_second_league_id
TG_CHAT_ID_2=your_second_group_chat_id
```

Save and close the editor, then restrict access:

```sh
sudo chown root:root /etc/fpl-bot.env
sudo chmod 600 /etc/fpl-bot.env
```

Do not commit this file or share its contents in chat.

## 4. Install and start the always-on service

From `/home/ubuntu/fpl_updates`, run:

```sh
sudo cp deploy/fpl-bot.service /etc/systemd/system/fpl-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now fpl-bot
sudo systemctl status fpl-bot
```

The service starts again automatically after a VM reboot or bot process failure. Test `/score` in each Telegram group. To inspect service logs, run `sudo journalctl -u fpl-bot -n 100 --no-pager`.

Keep only one copy of the polling bot running. Once the VM service responds, stop any local copy on your Mac.

## Update the bot later

```sh
cd /home/ubuntu/fpl_updates
git pull
.venv/bin/pip install -r requirements.txt
sudo systemctl restart fpl-bot
```
