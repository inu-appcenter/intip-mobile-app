Pod::Spec.new do |s|
  s.name           = 'IntipNotificationRelay'
  s.version        = '1.0.0'
  s.summary        = 'Stores the notification relay config for the iOS 27 Shortcuts notification automation'
  s.description    = 'Stores the notification relay config that RelayNotificationIntent (main app target) reads when a Shortcuts notification automation runs it'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = "**/*.{h,m,swift}"
end
