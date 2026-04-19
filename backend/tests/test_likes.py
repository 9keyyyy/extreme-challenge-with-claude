import uuid


async def test_like_toggle_on(client, post):
    response = await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user1"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["liked"] is True
    assert data["like_count"] == 1


async def test_like_toggle_off(client, post):
    await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user1"},
    )

    response = await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user1"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["liked"] is False
    assert data["like_count"] == 0

    get_resp = await client.get(f"/api/v1/posts/{post['id']}")
    assert get_resp.json()["like_count"] == 0


async def test_like_different_users(client, post):
    await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user1"},
    )

    response = await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user2"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["liked"] is True
    assert data["like_count"] == 2

    get_resp = await client.get(f"/api/v1/posts/{post['id']}")
    assert get_resp.json()["like_count"] == 2


async def test_like_retoggle_on(client, post):
    await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user1"},
    )

    await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user1"},
    )

    response = await client.post(
        f"/api/v1/posts/{post['id']}/likes",
        json={"user_id": "user1"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["liked"] is True
    assert data["like_count"] == 1


async def test_like_post_not_found(client):
    fake_id = str(uuid.uuid4())
    response = await client.post(
        f"/api/v1/posts/{fake_id}/likes",
        json={"user_id": "user1"},
    )
    assert response.status_code == 404
