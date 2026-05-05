import os
import random
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_pymongo import PyMongo
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)
app.config['MONGO_URI'] = os.getenv('MONGO_URI', 'mongodb://127.0.0.1:27017/casino_wallet_hub')
mongo = PyMongo(app)

games = {
    'roulette': {'bet': 2, 'outcomes': [0, 0, 4]},
    'fortune': {'bet': 3, 'outcomes': [0, 6, 9]},
    'spin': {'bet': 1, 'outcomes': [0, 0, 2]}
}

def timestamp():
    return datetime.utcnow().isoformat()

def users_col():
    return mongo.db.users

def tx_col():
    return mongo.db.transactions

def clean_user(user):
    return {'username': user['username'], 'balance': user['balance'], 'createdAt': user['createdAt']}

def log_tx(username, tx_type, amount, detail, balance_after):
    tx_col().insert_one({
        'username': username,
        'type': tx_type,
        'amount': amount,
        'detail': detail,
        'balanceAfter': balance_after,
        'createdAt': timestamp()
    })

@app.get('/api/health')
def health():
    return jsonify({'ok': True, 'message': 'Python API running'})

@app.post('/api/register')
def register():
    data = request.get_json() or {}
    username = data.get('username')
    if not username:
        return jsonify({'error': 'username is required'}), 400

    user = users_col().find_one({'username': username})
    if user:
        return jsonify(clean_user(user))

    new_user = {'username': username, 'balance': 10, 'createdAt': timestamp()}
    users_col().insert_one(new_user)
    log_tx(username, 'starter', 10, 'Starter balance', 10)
    return jsonify(new_user), 201

@app.get('/api/user/<username>')
def get_user(username):
    user = users_col().find_one({'username': username}, {'_id': 0})
    if not user:
        return jsonify({'error': 'User not found'}), 404
    history = list(tx_col().find({'username': username}, {'_id': 0}).sort('createdAt', -1).limit(10))
    return jsonify({'user': user, 'history': history})

@app.post('/api/deposit')
def deposit():
    data = request.get_json() or {}
    username = data.get('username')
    amount = float(data.get('amount', 0))
    if not username or amount <= 0:
        return jsonify({'error': 'Valid username and amount are required'}), 400

    user = users_col().find_one_and_update(
        {'username': username},
        {'$inc': {'balance': amount}},
        return_document=True
    )
    if not user:
        return jsonify({'error': 'User not found'}), 404
    updated = users_col().find_one({'username': username}, {'_id': 0})
    log_tx(username, 'deposit', amount, 'Funds added', updated['balance'])
    return jsonify(updated)

@app.post('/api/withdraw')
def withdraw():
    data = request.get_json() or {}
    username = data.get('username')
    amount = float(data.get('amount', 0))
    if not username or amount <= 0:
        return jsonify({'error': 'Valid username and amount are required'}), 400

    user = users_col().find_one({'username': username})
    if not user:
        return jsonify({'error': 'User not found'}), 404
    if user['balance'] < amount:
        return jsonify({'error': 'Insufficient balance'}), 400

    users_col().update_one({'username': username}, {'$inc': {'balance': -amount}})
    updated = users_col().find_one({'username': username}, {'_id': 0})
    log_tx(username, 'withdraw', -amount, 'Funds withdrawn', updated['balance'])
    return jsonify(updated)

@app.post('/api/play')
def play():
    data = request.get_json() or {}
    username = data.get('username')
    game = data.get('game')
    if not username or game not in games:
        return jsonify({'error': 'username and valid game are required'}), 400

    config = games[game]
    user = users_col().find_one({'username': username})
    if not user:
        return jsonify({'error': 'User not found'}), 404
    if user['balance'] < config['bet']:
        return jsonify({'error': 'Not enough balance'}), 400

    reward = random.choice(config['outcomes'])
    net = reward - config['bet']
    users_col().update_one({'username': username}, {'$inc': {'balance': net}})
    updated = users_col().find_one({'username': username}, {'_id': 0})
    log_tx(username, game, net, f'Reward {reward}' if reward > 0 else 'No payout', updated['balance'])
    return jsonify({'username': username, 'game': game, 'reward': reward, 'net': net, 'balance': updated['balance']})

if __name__ == '__main__':
    app.run(port=int(os.getenv('PORT', 5001)), debug=True)