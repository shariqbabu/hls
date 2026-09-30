#!/usr/bin/env python3
"""
Generate Telethon StringSession for GitHub Secrets (TG_SESSION)
Run this locally to get a fresh session string when AuthKeyDuplicatedError occurs.
"""

from telethon.sync import TelegramClient
from telethon.sessions import StringSession

print("=" * 60)
print("🔑 TELEGRAM STRING SESSION GENERATOR")
print("=" * 60)

api_id = input("Enter API ID (from https://my.telegram.org): ").strip()
api_hash = input("Enter API HASH: ").strip()

if not api_id or not api_hash:
    print("❌ API ID and API HASH are required!")
    exit(1)

with TelegramClient(StringSession(), int(api_id), api_hash) as client:
    session_str = client.session.save()
    me = client.get_me()
    print("\n" + "=" * 60)
    print(f"🎉 SUCCESS! Logged in as: {me.first_name} (ID: {me.id})")
    print("=" * 60)
    print("\n👇 Copy this string and paste it into GitHub Secret 'TG_SESSION':\n")
    print(session_str)
    print("\n" + "=" * 60)
