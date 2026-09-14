[{{siteUser}}]
user = {{siteUser}}
group = www-data
listen = {{socket}}
listen.owner = {{siteUser}}
listen.group = www-data
listen.mode = 0660
pm = dynamic
pm.max_children = 5
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
