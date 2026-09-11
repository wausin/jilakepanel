server {
    listen {{listen}};
{{tlsLines}}
    server_name {{domain}};

    access_log {{accessLog}};
    error_log {{errorLog}};
    client_max_body_size 64m;

    location / {
        proxy_pass {{appUrl}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
